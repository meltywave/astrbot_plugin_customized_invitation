from pathlib import Path

from PIL import Image, ImageColor, ImageDraw, ImageFont, UnidentifiedImageError

from .models import TemplateConfig, TextLayer


class RenderError(Exception):
    """Template rendering error."""


class TemplateRenderer:
    def __init__(self, fonts_dir: Path):
        self.fonts_dir = fonts_dir

    def render(self, template: TemplateConfig, data: dict[str, str]) -> Image.Image:
        """Render a template image.

        Args:
            template: Template configuration.
            data: User-provided field values.

        Returns:
            Rendered image.

        Raises:
            RenderError: If rendering fails.
            ValueError: If a required field is missing.
        """
        image = self._create_base_image(template)
        draw = ImageDraw.Draw(image)
        for layer in template.layers:
            if layer.type == "text":
                self._render_text_layer(draw, layer, data)
                continue
            raise RenderError(f"Unsupported layer type: {layer.type}")
        return image

    def _create_base_image(self, template: TemplateConfig) -> Image.Image:
        """Create the base image for a template.

        Args:
            template: Template configuration.

        Returns:
            Base image.

        Raises:
            RenderError: If the background image or color is invalid.
        """
        if template.background:
            background_path = template.directory / template.background
            try:
                image = Image.open(background_path).convert("RGBA")
            except FileNotFoundError as err:
                raise RenderError(
                    f"Template background image does not exist: {template.background}"
                ) from err
            except (OSError, UnidentifiedImageError) as err:
                raise RenderError(
                    f"Template background image cannot be read: {template.background}"
                ) from err
            if image.size != (template.width, template.height):
                return image.resize((template.width, template.height))
            return image

        try:
            color = ImageColor.getrgb(template.background_color)
        except ValueError as err:
            raise RenderError("Template background color is invalid.") from err
        return Image.new("RGBA", (template.width, template.height), color)

    def _render_text_layer(
        self,
        draw: ImageDraw.ImageDraw,
        layer: TextLayer,
        data: dict[str, str],
    ) -> None:
        """Render a text layer.

        Args:
            draw: Pillow drawing context.
            layer: Text layer configuration.
            data: User-provided field values.

        Raises:
            RenderError: If text color is invalid.
            ValueError: If a required field is missing.
        """
        text = data.get(layer.field, layer.default).strip()
        if not text and layer.required:
            raise ValueError(f"Missing required field: {layer.field}")

        font = self._load_font(layer)
        bbox = draw.textbbox((0, 0), text, font=font)
        text_width = bbox[2] - bbox[0]
        text_height = bbox[3] - bbox[1]

        if layer.align == "center":
            x = layer.x + (layer.w - text_width) / 2
        elif layer.align == "right":
            x = layer.x + layer.w - text_width
        else:
            x = layer.x

        if layer.valign == "middle":
            y = layer.y + (layer.h - text_height) / 2 - bbox[1]
        elif layer.valign == "bottom":
            y = layer.y + layer.h - text_height - bbox[1]
        else:
            y = layer.y - bbox[1]

        try:
            fill = ImageColor.getrgb(layer.color)
        except ValueError as err:
            raise RenderError(f"Layer {layer.id} color is invalid.") from err
        draw.text((x, y), text, font=font, fill=fill)

    def _load_font(
        self, layer: TextLayer
    ) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
        """Load a font for a text layer.

        Args:
            layer: Text layer configuration.

        Returns:
            Pillow font object.
        """
        candidates: list[Path | str] = []
        if layer.font:
            preset_fonts: dict[str, list[Path | str]] = {
                "microsoft_yahei": [Path("C:/Windows/Fonts/msyh.ttc")],
                "simhei": [Path("C:/Windows/Fonts/simhei.ttf")],
                "simsun": [Path("C:/Windows/Fonts/simsun.ttc")],
                "pingfang": ["/System/Library/Fonts/PingFang.ttc"],
                "noto_sans_cjk": [
                    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
                    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
                ],
                "dejavu_sans": ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"],
            }
            if layer.font in preset_fonts:
                candidates.extend(preset_fonts[layer.font])
            else:
                font_path = Path(layer.font)
                candidates.append(
                    font_path if font_path.is_absolute() else self.fonts_dir / font_path
                )
        candidates.extend(
            [
                Path("C:/Windows/Fonts/msyh.ttc"),
                Path("C:/Windows/Fonts/simhei.ttf"),
                "/System/Library/Fonts/PingFang.ttc",
                "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
                "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
            ],
        )

        for candidate in candidates:
            try:
                return ImageFont.truetype(str(candidate), layer.fontsize)
            except OSError:
                continue
        return ImageFont.load_default()
