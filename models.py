from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class TextLayer:
    """Text layer configuration.

    Args:
        id: Unique layer identifier.
        field: Input field name used as text content.
        x: Left coordinate of the text box.
        y: Top coordinate of the text box.
        w: Width of the text box.
        h: Height of the text box.
        font: Optional font file name or path.
        fontsize: Font size in pixels.
        align: Horizontal alignment, left, center, or right.
        valign: Vertical alignment, top, middle, or bottom.
        color: Text color in hex format.
        required: Whether this field must be provided by the user.
        default: Default text when the field is omitted.
    """

    id: str
    field: str
    x: int
    y: int
    w: int
    h: int
    font: str | None = None
    fontsize: int = 48
    align: str = "left"
    valign: str = "top"
    color: str = "#000000"
    required: bool = True
    default: str = ""
    type: str = field(default="text", init=False)


Layer = TextLayer


@dataclass(frozen=True)
class TemplateConfig:
    """Template configuration.

    Args:
        name: Template name.
        width: Output image width.
        height: Output image height.
        layers: Ordered render layers.
        directory: Template directory.
        background: Optional background image path relative to the template directory.
        background_color: Background color used when no background image exists.
    """

    name: str
    width: int
    height: int
    layers: list[Layer]
    directory: Path
    background: str | None = None
    background_color: str = "#ffffff"


@dataclass(frozen=True)
class InvitationRequest:
    """Parsed invitation command request.

    Args:
        template_name: Selected template name.
        fields: User-provided template fields.
    """

    template_name: str
    fields: dict[str, str]


RawConfig = dict[str, Any]
