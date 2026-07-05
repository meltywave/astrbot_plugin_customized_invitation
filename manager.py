import json
from pathlib import Path
from typing import Any

from .models import Layer, RawConfig, TemplateConfig, TextLayer


class TemplateConfigError(Exception):
    """Template configuration error."""


class TemplateManager:
    def __init__(self, templates_dir: Path):
        self.templates_dir = templates_dir

    def list_templates(self) -> list[str]:
        """List available template names.

        Returns:
            Sorted template names that contain a config.json file.
        """
        if not self.templates_dir.exists():
            return []
        return sorted(
            item.name
            for item in self.templates_dir.iterdir()
            if item.is_dir() and (item / "config.json").is_file()
        )

    def load(self, name: str) -> TemplateConfig:
        """Load and validate a template.

        Args:
            name: Template directory name.

        Returns:
            Parsed template configuration.

        Raises:
            TemplateConfigError: If the template is missing or invalid.
        """
        template_dir = self.templates_dir / name
        config_path = template_dir / "config.json"
        if not config_path.is_file():
            raise TemplateConfigError(f"模板不存在：{name}")

        try:
            with config_path.open("r", encoding="utf-8") as file:
                raw: RawConfig = json.load(file)
        except json.JSONDecodeError as err:
            raise TemplateConfigError(f"模板配置不是有效 JSON：{name}") from err
        except OSError as err:
            raise TemplateConfigError(f"无法读取模板配置：{name}") from err

        return self._parse_config(raw, template_dir, name)

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
            raise TemplateConfigError("模板配置必须包含至少一个图层。")

        layers: list[Layer] = []
        for index, layer_data in enumerate(layers_data):
            if not isinstance(layer_data, dict):
                raise TemplateConfigError(f"第 {index + 1} 个图层配置无效。")
            layer_type = layer_data.get("type")
            if layer_type == "text":
                layers.append(self._parse_text_layer(layer_data, index))
            else:
                raise TemplateConfigError(f"暂不支持的图层类型：{layer_type}")

        background = raw.get("background")
        if background is not None and not isinstance(background, str):
            raise TemplateConfigError("background 必须是字符串。")

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
            raise TemplateConfigError(f"图层 {layer_id} 缺少 field。")

        align = str(raw.get("align") or "left")
        valign = str(raw.get("valign") or "top")
        if align not in {"left", "center", "right"}:
            raise TemplateConfigError(f"图层 {layer_id} 的 align 无效。")
        if valign not in {"top", "middle", "bottom"}:
            raise TemplateConfigError(f"图层 {layer_id} 的 valign 无效。")

        font = raw.get("font")
        if font is not None and not isinstance(font, str):
            raise TemplateConfigError(f"图层 {layer_id} 的 font 必须是字符串。")

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
            required=bool(raw.get("required", True)),
            default=str(raw.get("default") or ""),
        )

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
            raise TemplateConfigError(f"{field_name} 必须是整数。")
        try:
            return int(value)
        except (TypeError, ValueError) as err:
            raise TemplateConfigError(f"{field_name} 必须是整数。") from err

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
            raise TemplateConfigError(f"{field_name} 必须大于 0。")
        return parsed
