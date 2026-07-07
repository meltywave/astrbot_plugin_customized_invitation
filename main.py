import base64
import binascii
import hashlib
from pathlib import Path
from urllib.parse import quote, urlencode
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

INVITATION_ALIAS = "邀请函"
UPLOAD_ALIAS = "上传模版"
SET_ALIAS = "设置模版"
LIST_ALIAS = "模版列表"

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
        self.context.register_web_api(
            f"/{PLUGIN_NAME}/editor/templates",
            self.list_editor_templates,
            ["GET"],
            "List templates available to the editor page.",
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
                f"请打开下面链接上传模版图片并框选填字区域：\n{editor_url}"
            )
        except ValueError as err:
            yield event.plain_result(str(err))
        except Exception as err:
            logger.exception("Failed to create template upload task: %s", err)
            yield event.plain_result("创建模版上传任务失败，请查看日志。")

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
            yield event.plain_result(f"已设置当前模版：{template_name}")
        except (TemplateConfigError, ValueError) as err:
            yield event.plain_result(str(err))
        except Exception as err:
            logger.exception("Failed to set invitation template: %s", err)
            yield event.plain_result("设置模版失败，请查看日志。")

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
                yield event.plain_result("请先使用 /设置模版 名称 选定当前模版。")
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
            yield event.plain_result("生成邀请函失败，请查看日志。")

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
            yield event.plain_result("暂无可用模版。")
            return
        yield event.plain_result("可用模版：" + "，".join(all_templates))

    async def list_editor_templates(self):
        """List templates for the current editor upload task.

        Returns:
            JSON response with user and global template names.
        """
        task_token = str(request.query.get("task") or "").strip()
        task = self.state.get_upload_task(task_token) if task_token else None
        if task_token and not task:
            return error_response("Upload task is invalid or expired.", status_code=404)

        user_templates = (
            self.manager.list_user_templates(str(task["owner_key"])) if task else []
        )
        global_templates = [
            name for name in self.manager.list_templates() if name not in user_templates
        ]
        return json_response(
            {
                "status": "ok",
                "current": str(task["template_name"]) if task else "",
                "mode": "user" if task else "global",
                "user_templates": user_templates,
                "global_templates": global_templates,
            }
        )

    async def save_editor_template(self):
        """Save template data submitted from the plugin editor page.

        Returns:
            JSON response with created template metadata.
        """
        content_type = str(request.content_type or "").lower()
        body = await request.json({}) if "application/json" in content_type else {}
        if body and not isinstance(body, dict):
            return error_response("Invalid request payload.", status_code=400)

        form = {}
        files = {}
        if not body:
            form = await request.form()
            files = await request.files()

        task_token = str(
            (body.get("task") if body else form.get("task"))
            or request.query.get("task")
            or ""
        ).strip()
        task = self.state.get_upload_task(task_token) if task_token else None
        if task_token and not task:
            return error_response("Upload task is invalid or expired.", status_code=404)

        upload_path = self.upload_dir / f"{task_token or uuid4().hex}.upload"
        self.upload_dir.mkdir(parents=True, exist_ok=True)
        if body:
            image_data = str(body.get("image") or "")
            if image_data.startswith("data:"):
                image_data = image_data.split(",", 1)[1] if "," in image_data else ""
            if not image_data:
                return error_response("Please upload one template image.")
            try:
                upload_path.write_bytes(base64.b64decode(image_data, validate=True))
            except (binascii.Error, OSError) as err:
                logger.warning("Failed to decode uploaded template image: %s", err)
                return error_response("Uploaded image data is invalid.")
        else:
            image_file = files.get("image")
            if image_file is None:
                return error_response("Please upload one template image.")
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
            value = body.get(key) if body else form.get(key)
            if value is not None:
                options[key] = str(value)

        try:
            template_name = str(
                (body.get("template_name") if body else form.get("template_name"))
                or (task["template_name"] if task else "")
            ).strip()
            if task:
                template = self.manager.create_for_user_from_image(
                    str(task["owner_key"]),
                    template_name,
                    upload_path,
                    options,
                )
            else:
                template = self.manager.create_from_image(
                    template_name,
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

        Raises:
            ValueError: If the public access URL is not configured.
        """
        base_url = str(self.config.get("public_base_url") or "").rstrip("/")
        if not base_url:
            raise ValueError(
                "请先在插件配置中填写“公开访问地址”，例如 "
                "http://1.2.3.4:6185 或 https://bot.example.com，"
                "然后重新发送“上传模版 xxx”。"
            )
        query = urlencode({"task": task_token, "name": template_name})
        return f"{base_url}/#/plugin-page/{quote(PLUGIN_NAME, safe='')}/editor?{query}"

    async def terminate(self):
        """Terminate plugin.

        Returns:
            None.
        """
