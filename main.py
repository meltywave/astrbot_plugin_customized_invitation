import hashlib
import socket
from pathlib import Path
from urllib.parse import quote
from uuid import uuid4

from astrbot.api import AstrBotConfig, logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star, register
from astrbot.api.web import error_response, json_response, request

from .manager import TemplateConfigError, TemplateManager
from .renderer import RenderError, TemplateRenderer
from .state import InvitationState
from .utils import parse_invitation_fields, parse_template_name

PLUGIN_NAME = "astrbot_plugin_customized_invitation"

INVITATION_ALIAS = "\u9080\u8bf7\u51fd"
UPLOAD_ALIAS = "\u4e0a\u4f20\u6a21\u7248"
SET_ALIAS = "\u8bbe\u7f6e\u6a21\u7248"
LIST_ALIAS = "\u6a21\u7248\u5217\u8868"

INVITATION_COMMANDS = {"invitation", INVITATION_ALIAS}
UPLOAD_COMMANDS = {"upload_template", UPLOAD_ALIAS}
SET_COMMANDS = {"set_template", SET_ALIAS}


@register(
    PLUGIN_NAME,
    "Meltyw4v3",
    "Customized invitation image generator",
    "1.0.0",
)
class CustomizedInvitationPlugin(Star):
    def __init__(self, context: Context, config: AstrBotConfig | None = None):
        super().__init__(context)
        self.config = config or {}
        self.plugin_dir = Path(__file__).resolve().parent
        self.manager = TemplateManager(self.plugin_dir / "templates")
        self.renderer = TemplateRenderer(self.plugin_dir / "fonts")
        self.state = InvitationState(self.plugin_dir / "storage" / "state.json")
        self.output_dir = self.plugin_dir / "outputs"
        self.upload_dir = self.plugin_dir / "storage" / "uploads"

    async def initialize(self):
        """Initialize plugin directories and Web APIs.

        Returns:
            None.
        """
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.upload_dir.mkdir(parents=True, exist_ok=True)
        self.context.register_web_api(
            f"/{PLUGIN_NAME}/editor/save",
            self.save_editor_template,
            ["POST"],
            "Save customized invitation template from the editor page.",
        )

    @filter.command("upload_template", alias={UPLOAD_ALIAS})
    async def upload_template(self, event: AstrMessageEvent):
        """Create a user template upload task.

        Args:
            event: AstrBot message event.

        Yields:
            AstrBot message event result with editor link or an error message.
        """
        try:
            template_name = parse_template_name(event.message_str, UPLOAD_COMMANDS)
            owner_key = self._owner_key(event)
            task_token = self.state.create_upload_task(owner_key, template_name)
            editor_url = self._editor_url(task_token, template_name)
            yield event.plain_result(
                "\u8bf7\u6253\u5f00\u4e0b\u9762\u94fe\u63a5\u4e0a\u4f20\u6a21\u7248\u56fe\u7247\u5e76\u6846\u9009\u586b\u5b57\u533a\u57df\uff1a\n"
                f"{editor_url}"
            )
        except ValueError as err:
            yield event.plain_result(str(err))
        except Exception as err:
            logger.exception("Failed to create template upload task: %s", err)
            yield event.plain_result(
                "\u521b\u5efa\u6a21\u7248\u4e0a\u4f20\u4efb\u52a1\u5931\u8d25\uff0c\u8bf7\u67e5\u770b\u65e5\u5fd7\u3002"
            )

    @filter.command("set_template", alias={SET_ALIAS})
    async def set_template(self, event: AstrMessageEvent):
        """Set the active template for the current user.

        Args:
            event: AstrBot message event.

        Yields:
            AstrBot message event result with status text.
        """
        try:
            template_name = parse_template_name(event.message_str, SET_COMMANDS)
            owner_key = self._owner_key(event)
            self.manager.load_for_user(owner_key, template_name)
            self.state.set_active_template(owner_key, template_name)
            yield event.plain_result(
                f"\u5df2\u8bbe\u7f6e\u5f53\u524d\u6a21\u7248\uff1a{template_name}"
            )
        except (TemplateConfigError, ValueError) as err:
            yield event.plain_result(str(err))
        except Exception as err:
            logger.exception("Failed to set invitation template: %s", err)
            yield event.plain_result(
                "\u8bbe\u7f6e\u6a21\u7248\u5931\u8d25\uff0c\u8bf7\u67e5\u770b\u65e5\u5fd7\u3002"
            )

    @filter.command("invitation", alias={INVITATION_ALIAS})
    async def invitation(self, event: AstrMessageEvent):
        """Generate an invitation image from the active user template.

        Args:
            event: AstrBot message event.

        Yields:
            AstrBot message event result with a generated image or an error message.
        """
        try:
            owner_key = self._owner_key(event)
            template_name = self.state.get_active_template(owner_key)
            if not template_name:
                yield event.plain_result(
                    "\u8bf7\u5148\u4f7f\u7528 /设置模版 名称 \u9009\u5b9a\u5f53\u524d\u6a21\u7248\u3002"
                )
                return

            request_data = parse_invitation_fields(
                event.message_str,
                template_name,
                INVITATION_COMMANDS,
            )
            template = self.manager.load_for_user(owner_key, request_data.template_name)
            image = self.renderer.render(template, request_data.fields)

            self.output_dir.mkdir(parents=True, exist_ok=True)
            output_path = self.output_dir / f"{uuid4().hex}.png"
            image.save(output_path)
            event.track_temporary_local_file(str(output_path))
            yield event.image_result(str(output_path))
        except (TemplateConfigError, RenderError, ValueError) as err:
            yield event.plain_result(str(err))
        except Exception as err:
            logger.exception("Failed to generate invitation image: %s", err)
            yield event.plain_result(
                "\u751f\u6210\u9080\u8bf7\u51fd\u5931\u8d25\uff0c\u8bf7\u67e5\u770b\u65e5\u5fd7\u3002"
            )

    @filter.command("templates_list", alias={LIST_ALIAS})
    async def templates_list(self, event: AstrMessageEvent):
        """List templates available to the current user.

        Args:
            event: AstrBot message event.

        Yields:
            AstrBot message event result with template names.
        """
        owner_key = self._owner_key(event)
        templates = self.manager.list_user_templates(owner_key)
        global_templates = self.manager.list_templates()
        all_templates = templates + [
            name for name in global_templates if name not in templates
        ]
        if not all_templates:
            yield event.plain_result("\u6682\u65e0\u53ef\u7528\u6a21\u7248\u3002")
            return
        yield event.plain_result(
            "\u53ef\u7528\u6a21\u7248\uff1a" + "\uff0c".join(all_templates)
        )

    async def save_editor_template(self):
        """Save template data submitted from the plugin editor page.

        Returns:
            JSON response with created template metadata.
        """
        form = await request.form()
        files = await request.files()
        task_token = str(form.get("task") or request.query.get("task") or "").strip()
        task = self.state.get_upload_task(task_token)
        if not task:
            return error_response("Upload task is invalid or expired.", status_code=404)

        image_file = files.get("image")
        if image_file is None:
            return error_response("Please upload one template image.")

        upload_path = self.upload_dir / f"{task_token}.upload"
        await image_file.save(upload_path)

        options: dict[str, str] = {}
        for key in (
            "x",
            "y",
            "w",
            "h",
            "fontsize",
            "align",
            "valign",
            "color",
            "font",
            "default",
        ):
            value = form.get(key)
            if value is not None:
                options[key] = str(value)

        try:
            template = self.manager.create_for_user_from_image(
                str(task["owner_key"]),
                str(task["template_name"]),
                upload_path,
                options,
            )
        except TemplateConfigError as err:
            return error_response(str(err), status_code=400)
        finally:
            try:
                upload_path.unlink(missing_ok=True)
            except OSError:
                logger.warning("Failed to remove temporary upload: %s", upload_path)

        layer = template.layers[0]
        return json_response(
            {
                "status": "ok",
                "template": template.name,
                "width": template.width,
                "height": template.height,
                "layer": {
                    "x": layer.x,
                    "y": layer.y,
                    "w": layer.w,
                    "h": layer.h,
                    "fontsize": layer.fontsize,
                    "color": layer.color,
                },
            }
        )

    def _owner_key(self, event: AstrMessageEvent) -> str:
        """Build a stable storage key for one message sender.

        Args:
            event: AstrBot message event.

        Returns:
            Hex owner key.
        """
        raw = "|".join(
            [
                event.get_platform_id() or event.get_platform_name(),
                event.get_sender_id() or event.get_session_id(),
            ]
        )
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]

    def _editor_url(self, task_token: str, template_name: str) -> str:
        """Build an absolute editor page URL.

        Args:
            task_token: Upload task token.
            template_name: Template name.

        Returns:
            Editor URL.
        """
        core_config = self.context.get_config()
        base_url = str(
            self.config.get("public_base_url")
            or core_config.get("callback_api_base")
            or ""
        ).rstrip("/")
        if not base_url:
            dashboard = core_config.get("dashboard", {})
            ssl_config = dashboard.get("ssl", {}) if isinstance(dashboard, dict) else {}
            scheme = (
                "https"
                if isinstance(ssl_config, dict) and ssl_config.get("enable")
                else "http"
            )
            port = dashboard.get("port", 6185) if isinstance(dashboard, dict) else 6185
            host = (
                str(dashboard.get("host") or "").strip()
                if isinstance(dashboard, dict)
                else ""
            )
            if host in {"", "0.0.0.0", "::", "[::]"}:
                host = "127.0.0.1"
                try:
                    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
                        sock.connect(("8.8.8.8", 80))
                        host = sock.getsockname()[0]
                except OSError:
                    try:
                        detected_host = socket.gethostbyname(socket.gethostname())
                        if not detected_host.startswith("127."):
                            host = detected_host
                    except OSError:
                        pass
            if ":" in host and not host.startswith("["):
                host = f"[{host}]"
            base_url = f"{scheme}://{host}:{port}"
        return (
            f"{base_url}/api/plugin/page/content/{PLUGIN_NAME}/editor/"
            f"?task={quote(task_token, safe='')}&name={quote(template_name, safe='')}"
        )

    async def terminate(self):
        """Terminate plugin.

        Returns:
            None.
        """
