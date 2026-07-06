import json
import re
from pathlib import Path
from typing import Any

from PIL import Image, UnidentifiedImageError

from .models import Layer, RawConfig, TemplateConfig, TextLayer


class TemplateConfigError(Exception):
    """Template configuration error."""


class TemplateManager:
    def __init__(self, templates_dir: Path):
        self.templates_dir = templates_dir

    def list_templates(self) -> list[str]:
        """List global template names.

        Returns:
            Sorted global template names that contain a config.json file.
        """
        return self._list_template_dirs(self.templates_dir)

    def list_user_templates(self, owner_key: str) -> list[str]:
        """List templates owned by one user.

        Args:
            owner_key: Stable user storage key.

        Returns:
            Sorted template names for this user.
        """
        return self._list_template_dirs(self._owner_dir(owner_key))

    def load(self, name: str) -> TemplateConfig:
        """Load and validate a global template.

        Args:
            name: Template directory name.

        Returns:
            Parsed template configuration.

        Raises:
            TemplateConfigError: If the template is missing or invalid.
        """
        return self._load_from_dir(
            self.templates_dir / self._safe_template_name(name), name
        )

    def load_for_user(self, owner_key: str, name: str) -> TemplateConfig:
        """Load a user template, falling back to global templates.

        Args:
            owner_key: Stable user storage key.
            name: Template name.

        Returns:
            Parsed template configuration.

        Raises:
            TemplateConfigError: If the template is missing or invalid.
        """
        safe_name = self._safe_template_name(name)
        user_template_dir = self._owner_dir(owner_key) / safe_name
        if (user_template_dir / "config.json").is_file():
            return self._load_from_dir(user_template_dir, name)
        return self.load(name)

    def create_from_image(
        self,
        name: str,
        image_path: Path,
        options: dict[str, str],
    ) -> TemplateConfig:
        """Create or replace a global template from a background image.

        Args:
            name: Template name.
            image_path: User-uploaded image path.
            options: Text layer options.

        Returns:
            Created template configuration.

        Raises:
            TemplateConfigError: If the image or options are invalid.
        """
        return self._create_from_image(self.templates_dir, name, image_path, options)

    def create_for_user_from_image(
        self,
        owner_key: str,
        name: str,
        image_path: Path,
        options: dict[str, str],
    ) -> TemplateConfig:
        """Create or replace a user-owned template from a background image.

        Args:
            owner_key: Stable user storage key.
            name: Template name.
            image_path: User-uploaded image path.
            options: Text layer options.

        Returns:
            Created template configuration.

        Raises:
            TemplateConfigError: If the image or options are invalid.
        """
        return self._create_from_image(
            self._owner_dir(owner_key), name, image_path, options
        )

    def update_text_layer(self, name: str, options: dict[str, str]) -> TemplateConfig:
        """Update a global template text layer.

        Args:
            name: Template name.
            options: Text layer options.

        Returns:
            Updated template configuration.

        Raises:
            TemplateConfigError: If the template or options are invalid.
        """
        return self._update_text_layer(self.load(name), options)

    def update_user_text_layer(
        self,
        owner_key: str,
        name: str,
        options: dict[str, str],
    ) -> TemplateConfig:
        """Update a user template text layer.

        Args:
            owner_key: Stable user storage key.
            name: Template name.
            options: Text layer options.

        Returns:
            Updated template configuration.

        Raises:
            TemplateConfigError: If the template or options are invalid.
        """
        template = self._load_from_dir(
            self._owner_dir(owner_key) / self._safe_template_name(name),
            name,
        )
        return self._update_text_layer(template, options)

    def _load_from_dir(self, template_dir: Path, fallback_name: str) -> TemplateConfig:
        """Load a template from a directory.

        Args:
            template_dir: Template directory.
            fallback_name: Template name used when config name is omitted.

        Returns:
            Parsed template configuration.

        Raises:
            TemplateConfigError: If the template cannot be read.
        """
        config_path = template_dir / "config.json"
        if not config_path.is_file():
            raise TemplateConfigError(f"Template does not exist: {fallback_name}")

        try:
            with config_path.open("r", encoding="utf-8") as file:
                raw: RawConfig = json.load(file)
        except json.JSONDecodeError as err:
            raise TemplateConfigError(
                f"Template config is not valid JSON: {fallback_name}"
            ) from err
        except OSError as err:
            raise TemplateConfigError(
                f"Cannot read template config: {fallback_name}"
            ) from err

        return self._parse_config(raw, template_dir, fallback_name)

    def _create_from_image(
        self,
        base_dir: Path,
        name: str,
        image_path: Path,
        options: dict[str, str],
    ) -> TemplateConfig:
        """Create or replace a template under a base directory.

        Args:
            base_dir: Template base directory.
            name: Template name.
            image_path: Uploaded image path.
            options: Text layer options.

        Returns:
            Created template configuration.

        Raises:
            TemplateConfigError: If the image or options are invalid.
        """
        safe_name = self._safe_template_name(name)
        template_dir = base_dir / safe_name
        template_dir.mkdir(parents=True, exist_ok=True)
        background_path = template_dir / "bg.png"

        try:
            with Image.open(image_path) as image:
                converted = image.convert("RGBA")
                width, height = converted.size
                converted.save(background_path)
        except FileNotFoundError as err:
            raise TemplateConfigError("Uploaded image file was not found.") from err
        except (OSError, UnidentifiedImageError) as err:
            raise TemplateConfigError("Uploaded file is not a readable image.") from err

        layer = self._text_layer_from_options(
            options,
            default_width=width,
            default_height=height,
        )
        raw = {
            "name": safe_name,
            "width": width,
            "height": height,
            "background": "bg.png",
            "layers": [self._text_layer_to_raw(layer)],
        }
        self._write_config(template_dir, raw)
        return self._load_from_dir(template_dir, safe_name)

    def _update_text_layer(
        self,
        template: TemplateConfig,
        options: dict[str, str],
    ) -> TemplateConfig:
        """Update the first matching text layer in a template.

        Args:
            template: Loaded template configuration.
            options: Text layer options.

        Returns:
            Updated template configuration.

        Raises:
            TemplateConfigError: If the template cannot be updated.
        """
        config_path = template.directory / "config.json"
        try:
            with config_path.open("r", encoding="utf-8") as file:
                raw: RawConfig = json.load(file)
        except (json.JSONDecodeError, OSError) as err:
            raise TemplateConfigError(
                f"Cannot read template config: {template.name}"
            ) from err

        layers = raw.get("layers")
        if not isinstance(layers, list) or not layers:
            raise TemplateConfigError("Template has no editable text layer.")

        target_layer_id = options.get("layer", "name")
        target_layer = None
        for layer in layers:
            if isinstance(layer, dict) and layer.get("id") == target_layer_id:
                target_layer = layer
                break
        if target_layer is None:
            for layer in layers:
                if isinstance(layer, dict) and layer.get("type") == "text":
                    target_layer = layer
                    break
        if target_layer is None:
            raise TemplateConfigError("Template has no editable text layer.")

        merged = dict(target_layer)
        for key in {
            "field",
            "x",
            "y",
            "w",
            "h",
            "font",
            "fontsize",
            "align",
            "valign",
            "color",
            "required",
            "default",
        }:
            if key in options:
                merged[key] = options[key]
        parsed_layer = self._parse_text_layer(merged, 0)
        target_layer.clear()
        target_layer.update(self._text_layer_to_raw(parsed_layer))
        self._write_config(template.directory, raw)
        return self._load_from_dir(template.directory, template.name)

    def _parse_config(
        self,
        raw: RawConfig,
        template_dir: Path,
        fallback_name: str,
    ) -> TemplateConfig:
        """Parse raw template config.

        Args:
            raw: Raw JSON config.
            template_dir: Directory containing the template.
            fallback_name: Directory name used when config name is omitted.

        Returns:
            Parsed template configuration.

        Raises:
            TemplateConfigError: If required fields are missing or invalid.
        """
        name = str(raw.get("name") or fallback_name).strip()
        width = self._positive_int(raw.get("width"), "width")
        height = self._positive_int(raw.get("height"), "height")
        layers_data = raw.get("layers")
        if not isinstance(layers_data, list) or not layers_data:
            raise TemplateConfigError(
                "Template config must contain at least one layer."
            )

        layers: list[Layer] = []
        for index, layer_data in enumerate(layers_data):
            if not isinstance(layer_data, dict):
                raise TemplateConfigError(f"Layer {index + 1} config is invalid.")
            layer_type = layer_data.get("type")
            if layer_type == "text":
                layers.append(self._parse_text_layer(layer_data, index))
            else:
                raise TemplateConfigError(f"Unsupported layer type: {layer_type}")

        background = raw.get("background")
        if background is not None and not isinstance(background, str):
            raise TemplateConfigError("background must be a string.")

        background_color = str(raw.get("background_color") or "#ffffff")
        return TemplateConfig(
            name=name,
            width=width,
            height=height,
            layers=layers,
            directory=template_dir,
            background=background,
            background_color=background_color,
        )

    def _parse_text_layer(self, raw: dict[str, Any], index: int) -> TextLayer:
        """Parse a text layer.

        Args:
            raw: Raw text layer data.
            index: Zero-based layer index.

        Returns:
            Parsed text layer.

        Raises:
            TemplateConfigError: If the layer is invalid.
        """
        layer_id = str(raw.get("id") or f"text_{index + 1}").strip()
        field = str(raw.get("field") or "").strip()
        if not field:
            raise TemplateConfigError(f"Layer {layer_id} is missing field.")

        align = str(raw.get("align") or "left")
        valign = str(raw.get("valign") or "top")
        if align not in {"left", "center", "right"}:
            raise TemplateConfigError(f"Layer {layer_id} align is invalid.")
        if valign not in {"top", "middle", "bottom"}:
            raise TemplateConfigError(f"Layer {layer_id} valign is invalid.")

        font = raw.get("font")
        if font is not None and not isinstance(font, str):
            raise TemplateConfigError(f"Layer {layer_id} font must be a string.")

        return TextLayer(
            id=layer_id,
            field=field,
            x=self._int(raw.get("x"), f"{layer_id}.x"),
            y=self._int(raw.get("y"), f"{layer_id}.y"),
            w=self._positive_int(raw.get("w"), f"{layer_id}.w"),
            h=self._positive_int(raw.get("h"), f"{layer_id}.h"),
            font=font,
            fontsize=self._positive_int(
                raw.get("fontsize", 48), f"{layer_id}.fontsize"
            ),
            align=align,
            valign=valign,
            color=str(raw.get("color") or "#000000"),
            required=self._bool(raw.get("required", True), f"{layer_id}.required"),
            default=str(raw.get("default") or ""),
        )

    def _text_layer_from_options(
        self,
        options: dict[str, str],
        default_width: int,
        default_height: int,
    ) -> TextLayer:
        """Create a text layer from command options.

        Args:
            options: Text layer options.
            default_width: Background image width.
            default_height: Background image height.

        Returns:
            Parsed text layer.

        Raises:
            TemplateConfigError: If options are invalid.
        """
        raw = {
            "id": options.get("id", "name"),
            "type": "text",
            "field": options.get("field", "name"),
            "x": options.get("x", str(default_width // 10)),
            "y": options.get("y", str(default_height // 2)),
            "w": options.get("w", str(default_width * 8 // 10)),
            "h": options.get("h", str(max(80, default_height // 8))),
            "fontsize": options.get("fontsize", str(max(32, default_height // 12))),
            "align": options.get("align", "center"),
            "valign": options.get("valign", "middle"),
            "color": options.get("color", "#000000"),
            "required": options.get("required", True),
            "default": options.get("default", ""),
        }
        if "font" in options:
            raw["font"] = options["font"]
        return self._parse_text_layer(raw, 0)

    def _text_layer_to_raw(self, layer: TextLayer) -> dict[str, Any]:
        """Convert a text layer to JSON-compatible data.

        Args:
            layer: Text layer.

        Returns:
            JSON-compatible layer data.
        """
        raw: dict[str, Any] = {
            "id": layer.id,
            "type": "text",
            "field": layer.field,
            "x": layer.x,
            "y": layer.y,
            "w": layer.w,
            "h": layer.h,
            "fontsize": layer.fontsize,
            "align": layer.align,
            "valign": layer.valign,
            "color": layer.color,
            "required": layer.required,
            "default": layer.default,
        }
        if layer.font:
            raw["font"] = layer.font
        return raw

    def _list_template_dirs(self, base_dir: Path) -> list[str]:
        """List template directories below a base directory.

        Args:
            base_dir: Base template directory.

        Returns:
            Sorted template names.
        """
        if not base_dir.exists():
            return []
        return sorted(
            item.name
            for item in base_dir.iterdir()
            if item.is_dir()
            and item.name != "users"
            and (item / "config.json").is_file()
        )

    def _owner_dir(self, owner_key: str) -> Path:
        """Return the template directory for one owner.

        Args:
            owner_key: Stable user storage key.

        Returns:
            Owner template directory.
        """
        return self.templates_dir / "users" / owner_key

    def _safe_template_name(self, name: str) -> str:
        """Validate a template name for filesystem storage.

        Args:
            name: User-provided template name.

        Returns:
            Safe template name.

        Raises:
            TemplateConfigError: If the name is invalid.
        """
        safe_name = name.strip()
        if not safe_name or safe_name in {".", ".."} or len(safe_name) > 64:
            raise TemplateConfigError("Template name must be 1-64 characters.")
        if re.search(r'[<>:"/\\|?*\x00-\x1f]', safe_name):
            raise TemplateConfigError(
                'Template name cannot contain <>:"/\\|?* or control characters.'
            )
        return safe_name

    def _int(self, value: Any, field_name: str) -> int:
        """Parse an integer field.

        Args:
            value: Raw value.
            field_name: Field name for error messages.

        Returns:
            Parsed integer.

        Raises:
            TemplateConfigError: If the value is not an integer.
        """
        if isinstance(value, bool):
            raise TemplateConfigError(f"{field_name} must be an integer.")
        try:
            return int(value)
        except (TypeError, ValueError) as err:
            raise TemplateConfigError(f"{field_name} must be an integer.") from err

    def _positive_int(self, value: Any, field_name: str) -> int:
        """Parse a positive integer field.

        Args:
            value: Raw value.
            field_name: Field name for error messages.

        Returns:
            Parsed positive integer.

        Raises:
            TemplateConfigError: If the value is not a positive integer.
        """
        parsed = self._int(value, field_name)
        if parsed <= 0:
            raise TemplateConfigError(f"{field_name} must be greater than 0.")
        return parsed

    def _bool(self, value: Any, field_name: str) -> bool:
        """Parse a boolean field.

        Args:
            value: Raw value.
            field_name: Field name for error messages.

        Returns:
            Parsed boolean.

        Raises:
            TemplateConfigError: If the value is not boolean-like.
        """
        if isinstance(value, bool):
            return value
        if isinstance(value, str):
            normalized = value.strip().lower()
            if normalized in {"true", "1", "yes", "y"}:
                return True
            if normalized in {"false", "0", "no", "n"}:
                return False
        raise TemplateConfigError(f"{field_name} must be true or false.")

    def _write_config(self, template_dir: Path, raw: RawConfig) -> None:
        """Write template config JSON.

        Args:
            template_dir: Template directory.
            raw: JSON-compatible config.

        Raises:
            TemplateConfigError: If the config cannot be written.
        """
        try:
            with (template_dir / "config.json").open("w", encoding="utf-8") as file:
                json.dump(raw, file, ensure_ascii=False, indent=2)
                file.write("\n")
        except OSError as err:
            raise TemplateConfigError("Cannot write template config.") from err
