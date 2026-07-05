from pathlib import Path
from uuid import uuid4

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star, register

from .manager import TemplateConfigError, TemplateManager
from .renderer import RenderError, TemplateRenderer
from .utils import parse_command_args


@register(
    "astrbot_plugin_customized_invitation",
    "Meltyw4v3",
    "Customized invitation image generator",
    "1.0.0",
)
class CustomizedInvitationPlugin(Star):
    def __init__(self, context: Context):
        super().__init__(context)
        self.plugin_dir = Path(__file__).resolve().parent
        self.manager = TemplateManager(self.plugin_dir / "templates")
        self.renderer = TemplateRenderer(self.plugin_dir / "fonts")
        self.output_dir = self.plugin_dir / "outputs"

    async def initialize(self):
        """Initialize plugin directories.

        Returns:
            None.
        """
        self.output_dir.mkdir(parents=True, exist_ok=True)

    @filter.command("invitation", "邀请函")
    async def invitation(self, event: AstrMessageEvent):
        """Generate an invitation image from a template.

        Args:
            event: AstrBot message event.

        Yields:
            AstrBot message event result with a generated image or an error message.
        """
        try:
            request = parse_command_args(
                event.message_str, self.manager.list_templates()
            )
            template = self.manager.load(request.template_name)
            image = self.renderer.render(template, request.fields)

            self.output_dir.mkdir(parents=True, exist_ok=True)
            output_path = self.output_dir / f"{template.name}_{uuid4().hex}.png"
            image.save(output_path)
            event.track_temporary_local_file(str(output_path))
            yield event.image_result(str(output_path))
        except (TemplateConfigError, RenderError, ValueError) as err:
            yield event.plain_result(str(err))
        except Exception as err:
            logger.exception("Failed to generate invitation image: %s", err)
            yield event.plain_result("生成邀请函失败，请联系管理员查看日志。")

    async def terminate(self):
        """Terminate plugin.

        Returns:
            None.
        """
