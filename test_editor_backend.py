import asyncio
import base64
import json
import os
import sys
import tempfile
import unittest
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

from PIL import Image, ImageDraw

PLUGIN_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(PLUGIN_DIR.parent))

from astrbot_plugin_customized_invitation.manager import (  # noqa: E402
    TemplateConfigError,
    TemplateManager,
)
from astrbot_plugin_customized_invitation.renderer import TemplateRenderer  # noqa: E402
from astrbot_plugin_customized_invitation.state import InvitationState  # noqa: E402


class EditorBackendTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(dir=PLUGIN_DIR)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.manager = TemplateManager(self.root)

    def test_legacy_template_defaults_to_zero_rotation(self) -> None:
        template_dir = self.root / "legacy"
        template_dir.mkdir()
        (template_dir / "config.json").write_text(
            json.dumps(
                {
                    "name": "legacy",
                    "width": 120,
                    "height": 120,
                    "layers": [
                        {
                            "id": "name",
                            "type": "text",
                            "field": "name",
                            "x": 20,
                            "y": 40,
                            "w": 80,
                            "h": 30,
                            "fontsize": 20,
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )
        self.assertEqual(self.manager.load("legacy").layers[0].rotation, 0)
        self.assertEqual(
            self.manager.load("legacy").layers[0].orientation, "horizontal"
        )

    def test_uploaded_image_replaces_template_canvas_and_preview(self) -> None:
        source = self.root / "source.png"
        Image.new("RGB", (240, 160), "white").save(source)
        template = self.manager.create_from_image("sample", source, {})
        original = (template.directory / "config.json").read_bytes()
        self.assertEqual(
            self.manager.template_metadata(template),
            {"display_name": "sample", "preview": ""},
        )

        preview = BytesIO()
        Image.new("RGB", (40, 30), "red").save(preview, format="PNG")
        template = self.manager.update_template_metadata(
            template, "Renamed", preview.getvalue()
        )
        self.assertEqual(
            self.manager.template_metadata(template),
            {"display_name": "Renamed", "preview": "preview.png"},
        )
        self.assertFalse((self.root / "sample").exists())
        saved = json.loads((template.directory / "config.json").read_text("utf-8"))
        previous = json.loads(original)
        previous["name"] = "Renamed"
        previous["width"], previous["height"] = 40, 30
        previous["layers"][0].update(x=4, y=15, w=32, h=15, fontsize=8)
        self.assertEqual(saved, previous)
        self.assertEqual(self.manager.load("Renamed").width, 40)
        self.assertEqual(self.manager.load("Renamed").height, 30)
        with Image.open(template.directory / "bg.png") as image:
            self.assertEqual(image.size, (40, 30))
            self.assertEqual(image.convert("RGB").getpixel((0, 0)), (255, 0, 0))
        with Image.open(template.directory / "preview.png") as image:
            self.assertEqual(image.size, (40, 30))

        template = self.manager.update_template_metadata(template, "Again", None)
        self.assertEqual(
            self.manager.template_metadata(template)["display_name"], "Again"
        )
        self.assertFalse((self.root / "Renamed").exists())
        with Image.open(template.directory / "preview.png") as image:
            self.assertEqual(image.size, (40, 30))
        with Image.open(template.directory / "bg.png") as image:
            self.assertEqual(image.size, (40, 30))

    def test_invalid_template_metadata_does_not_replace_existing_values(self) -> None:
        source = self.root / "source.png"
        Image.new("RGB", (100, 100), "white").save(source)
        template = self.manager.create_from_image("sample", source, {})
        with self.assertRaisesRegex(TemplateConfigError, "1-64 characters"):
            self.manager.update_template_metadata(template, "  ", None)
        with self.assertRaisesRegex(TemplateConfigError, "Canvas image is invalid"):
            self.manager.update_template_metadata(template, "Changed", b"not an image")
        self.assertEqual(
            self.manager.template_metadata(template)["display_name"], "sample"
        )

    def test_upload_to_global_template_from_user_keeps_global_canvas(self) -> None:
        source = self.root / "source.png"
        Image.new("RGB", (120, 80), "blue").save(source)
        global_template = self.manager.create_from_image("shared", source, {})
        original_config = (global_template.directory / "config.json").read_bytes()
        image_data = BytesIO()
        Image.new("RGB", (50, 40), "red").save(image_data, format="PNG")

        user_template = self.manager.update_template_metadata(
            global_template, "renamed", image_data.getvalue(), "owner"
        )
        self.assertEqual(global_template.directory.name, "shared")
        self.assertEqual(
            (global_template.directory / "config.json").read_bytes(), original_config
        )
        with Image.open(global_template.directory / "bg.png") as image:
            self.assertEqual(image.convert("RGB").getpixel((0, 0)), (0, 0, 255))
        self.assertEqual(user_template.directory.name, "renamed")
        self.assertEqual(user_template.width, 50)
        self.assertEqual(user_template.height, 40)
        with Image.open(user_template.directory / "bg.png") as image:
            self.assertEqual(image.convert("RGB").getpixel((0, 0)), (255, 0, 0))

    def test_config_endpoint_accepts_uploaded_canvas_without_body_argument(
        self,
    ) -> None:
        template = self.manager.create_empty_template("Current")
        canvas = BytesIO()
        Image.new("RGB", (320, 180), "green").save(canvas, format="PNG")
        body = {
            "action": "update",
            "template": "Current",
            "display_name": "Current",
            "preview": "data:image/png;base64,"
            + base64.b64encode(canvas.getvalue()).decode("ascii"),
        }

        with patch.dict(os.environ, {"ASTRBOT_ROOT": str(self.root)}):
            from astrbot_plugin_customized_invitation.main import (
                CustomizedInvitationPlugin,
            )

            plugin = CustomizedInvitationPlugin.__new__(CustomizedInvitationPlugin)
            plugin.manager = self.manager
            plugin.state = InvitationState(self.root / "state.json")
            plugin.upload_dir = self.root / "uploads"

            class RequestStub:
                async def json(self, default):
                    return body

            with (
                patch(
                    "astrbot_plugin_customized_invitation.main.request", RequestStub()
                ),
                patch(
                    "astrbot_plugin_customized_invitation.main.json_response",
                    side_effect=lambda payload: payload,
                ),
            ):
                result = asyncio.run(plugin.save_template_config())

        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["template"], "Current")
        updated = self.manager.load("Current")
        self.assertEqual((updated.width, updated.height), (320, 180))
        self.assertEqual(
            self.manager.template_metadata(template)["preview"], "preview.png"
        )

    def test_delete_endpoint_clears_bindings_and_rejects_other_owners(self) -> None:
        state = InvitationState(self.root / "state.json")
        with patch.dict(os.environ, {"ASTRBOT_ROOT": str(self.root)}):
            from astrbot_plugin_customized_invitation.main import (
                CustomizedInvitationPlugin,
            )

            plugin = CustomizedInvitationPlugin.__new__(CustomizedInvitationPlugin)
            plugin.manager = self.manager
            plugin.state = state

            class RequestStub:
                body: dict = {}

                async def json(self, default):
                    return self.body

            request_stub = RequestStub()
            with (
                patch(
                    "astrbot_plugin_customized_invitation.main.request", request_stub
                ),
                patch(
                    "astrbot_plugin_customized_invitation.main.json_response",
                    side_effect=lambda payload: payload,
                ),
                patch(
                    "astrbot_plugin_customized_invitation.main.error_response",
                    side_effect=lambda message, status_code=400: {
                        "status": "error",
                        "message": message,
                    },
                ),
            ):
                global_template = self.manager.create_empty_template("Shared")
                token = state.create_upload_task("owner", "Shared")
                request_stub.body = {
                    "task": token,
                    "action": "delete",
                    "template": "Shared",
                }
                denied = asyncio.run(plugin.save_template_config())
                self.assertEqual(denied["status"], "error")
                self.assertTrue(global_template.directory.exists())

                own_template = self.manager.create_empty_template("Private", "owner")
                state.set_active_template("owner", "Private")
                state.set_upload_task_template(token, "Private")
                request_stub.body = {
                    "task": token,
                    "action": "delete",
                    "template": "Private",
                }
                deleted = asyncio.run(plugin.save_template_config())
                self.assertEqual(deleted, {"status": "ok", "deleted": "Private"})
                self.assertFalse(own_template.directory.exists())
                self.assertIsNone(state.get_active_template("owner"))
                self.assertEqual(state.get_upload_task(token)["template_name"], "")

    def test_disabling_last_template_clears_invitation_binding(self) -> None:
        state = InvitationState(self.root / "state.json")
        template = self.manager.create_empty_template("Shared")
        token = state.create_upload_task("owner", "Shared")
        state.set_active_template("owner", "Shared")

        with patch.dict(os.environ, {"ASTRBOT_ROOT": str(self.root)}):
            from astrbot_plugin_customized_invitation.main import (
                CustomizedInvitationPlugin,
            )

            plugin = CustomizedInvitationPlugin.__new__(CustomizedInvitationPlugin)
            plugin.manager = self.manager
            plugin.state = state

            class RequestStub:
                async def json(self, default):
                    return {
                        "task": token,
                        "action": "bind",
                        "template": template.name,
                        "active_template": "",
                    }

            with (
                patch(
                    "astrbot_plugin_customized_invitation.main.request", RequestStub()
                ),
                patch(
                    "astrbot_plugin_customized_invitation.main.json_response",
                    side_effect=lambda payload: payload,
                ),
            ):
                result = asyncio.run(plugin.save_template_config())

            self.assertEqual(result["active_template"], "")
            self.assertIsNone(state.get_active_template("owner"))
            self.assertEqual(state.get_upload_task(token)["template_name"], "")

            class EventStub:
                message_str = "/invitation Alice"

                def get_platform_id(self):
                    return "test"

                def get_sender_id(self):
                    return "owner"

                def plain_result(self, value):
                    return value

            async def collect():
                return [result async for result in plugin.invitation(EventStub())]

            with patch.object(plugin, "_owner_key", return_value="owner"):
                self.assertEqual(asyncio.run(collect()), ["当前无启用模版。"])

    def test_explicit_global_disable_blocks_existing_user_selection(self) -> None:
        state = InvitationState(self.root / "state.json")
        state.set_active_template("owner", "Personal")
        self.assertEqual(state.get_effective_template("owner"), "Personal")
        state.set_active_template("editor-global", "")
        self.assertIsNone(state.get_effective_template("owner"))
        state.set_active_template("editor-global", "Shared")
        self.assertEqual(state.get_effective_template("owner"), "Personal")
        self.assertEqual(state.get_effective_template("other"), "Shared")
        state.set_active_template("owner", "")
        self.assertIsNone(state.get_effective_template("owner"))

    def test_template_binding_updates_upload_task(self) -> None:
        state = InvitationState(self.root / "state.json")
        token = state.create_upload_task("owner", "old")
        state.set_upload_task_template(token, "new")
        self.assertEqual(state.get_upload_task(token)["template_name"], "new")
        with self.assertRaisesRegex(ValueError, "invalid or expired"):
            state.set_upload_task_template("missing", "new")

    def test_renaming_updates_active_and_task_template_references(self) -> None:
        state = InvitationState(self.root / "state.json")
        owner_task = state.create_upload_task("owner", "old")
        other_task = state.create_upload_task("other", "old")
        state.set_active_template("owner", "old")
        state.set_active_template("other", "old")
        state.rename_template_references("old", "new", "owner")
        self.assertEqual(state.get_upload_task(owner_task)["template_name"], "new")
        self.assertEqual(state.get_upload_task(other_task)["template_name"], "old")
        self.assertEqual(state.get_active_template("owner"), "new")
        self.assertEqual(state.get_active_template("other"), "old")

    def test_empty_template_uses_name_as_primary_key(self) -> None:
        template = self.manager.create_empty_template("Invitation")
        self.assertEqual(template.name, "Invitation")
        self.assertEqual(template.directory.name, "Invitation")
        self.assertEqual(template.background_color, "#ffffff")
        with self.assertRaisesRegex(TemplateConfigError, "already exists"):
            self.manager.create_empty_template("Invitation")

    def test_new_template_image_replaces_blank_canvas(self) -> None:
        template = self.manager.create_empty_template("New")
        canvas = BytesIO()
        Image.new("RGB", (320, 180), "green").save(canvas, format="PNG")
        updated = self.manager.update_template_metadata(
            template, "New", canvas.getvalue()
        )
        self.assertEqual((updated.width, updated.height), (320, 180))
        self.assertEqual(updated.background, "bg.png")
        with Image.open(updated.directory / "bg.png") as image:
            self.assertEqual(image.convert("RGB").getpixel((0, 0)), (0, 128, 0))

    def test_rename_rejects_a_name_that_already_exists(self) -> None:
        first = self.manager.create_empty_template("First")
        second = self.manager.create_empty_template("Second")
        with self.assertRaisesRegex(TemplateConfigError, "already exists"):
            self.manager.update_template_metadata(first, "Second", None)
        self.assertEqual(self.manager.load("First").name, "First")
        self.assertEqual(self.manager.load("Second").directory, second.directory)

    def test_deleting_template_removes_its_directory(self) -> None:
        first = self.manager.create_empty_template("First")
        second = self.manager.create_empty_template("Second")
        self.manager.delete_template("First")
        self.assertFalse(first.directory.exists())
        self.assertEqual(self.manager.load("Second").directory, second.directory)
        with self.assertRaisesRegex(TemplateConfigError, "does not exist"):
            self.manager.delete_template("First")

    def test_user_deletion_cannot_remove_global_template(self) -> None:
        global_template = self.manager.create_empty_template("Shared")
        user_template = self.manager.create_empty_template("Private", "owner")
        with self.assertRaisesRegex(TemplateConfigError, "does not exist"):
            self.manager.delete_template("Shared", "owner")
        self.manager.delete_template("Private", "owner")
        self.assertFalse(user_template.directory.exists())
        self.assertTrue(global_template.directory.exists())

    def test_deleting_template_clears_only_its_owner_bindings(self) -> None:
        state = InvitationState(self.root / "state.json")
        owner_task = state.create_upload_task("owner", "Shared")
        other_task = state.create_upload_task("other", "Shared")
        state.set_active_template("owner", "Shared")
        state.set_active_template("other", "Shared")
        state.clear_template_references("Shared", "owner")
        self.assertEqual(state.get_upload_task(owner_task)["template_name"], "")
        self.assertIsNone(state.get_active_template("owner"))
        self.assertEqual(state.get_upload_task(other_task)["template_name"], "Shared")
        self.assertEqual(state.get_active_template("other"), "Shared")

    def test_updating_existing_layer_preserves_background_and_other_layers(
        self,
    ) -> None:
        template_dir = self.root / "default"
        template_dir.mkdir()
        raw = {
            "name": "default",
            "width": 1200,
            "height": 675,
            "background_color": "#f7f2ea",
            "layers": [
                {
                    "id": "title",
                    "type": "text",
                    "field": "title",
                    "x": 120,
                    "y": 120,
                    "w": 960,
                    "h": 90,
                    "fontsize": 64,
                },
                {
                    "id": "date",
                    "type": "text",
                    "field": "date",
                    "x": 150,
                    "y": 460,
                    "w": 900,
                    "h": 70,
                    "fontsize": 42,
                },
            ],
        }
        (template_dir / "config.json").write_text(json.dumps(raw), encoding="utf-8")
        updated = self.manager.update_text_layer(
            "default", {"layer": "title", "x": "130", "default": "Edited"}
        )
        saved = json.loads((template_dir / "config.json").read_text(encoding="utf-8"))
        self.assertEqual(updated.layers[0].x, 130)
        self.assertEqual(saved["background_color"], "#f7f2ea")
        self.assertEqual(saved["layers"][1], raw["layers"][1])

    def test_updating_global_layer_for_user_copies_without_changing_global(
        self,
    ) -> None:
        source = self.root / "source.png"
        Image.new("RGB", (240, 160), "white").save(source)
        global_template = self.manager.create_from_image("shared", source, {})
        original = (global_template.directory / "config.json").read_bytes()
        updated = self.manager.update_user_text_layer(
            "owner", "shared", {"layer": "name", "x": "80"}
        )
        self.assertEqual(updated.layers[0].x, 80)
        self.assertEqual(
            (global_template.directory / "config.json").read_bytes(), original
        )
        self.assertEqual(self.manager.load_for_user("owner", "shared").layers[0].x, 80)

    def test_vertical_orientation_round_trip_and_rendering(self) -> None:
        source = self.root / "source.png"
        Image.new("RGB", (220, 260), "white").save(source)
        template = self.manager.create_from_image(
            "vertical",
            source,
            {
                "x": "80",
                "y": "20",
                "w": "60",
                "h": "210",
                "fontsize": "30",
                "orientation": "vertical",
                "valign": "top",
                "color": "#000000",
            },
        )
        self.assertEqual(template.layers[0].orientation, "vertical")
        self.assertEqual(
            self.manager.load("vertical").layers[0].orientation, "vertical"
        )
        config = json.loads((self.root / "vertical" / "config.json").read_text("utf-8"))
        self.assertEqual(config["layers"][0]["orientation"], "vertical")

        image = TemplateRenderer(self.root / "fonts").render(template, {"name": "MMMM"})
        bounds = (
            image.convert("L").point(lambda value: 255 if value < 128 else 0).getbbox()
        )
        self.assertIsNotNone(bounds)
        self.assertGreater(bounds[3] - bounds[1], (bounds[2] - bounds[0]) * 2)

    def test_invalid_orientation_is_rejected(self) -> None:
        source = self.root / "source.png"
        Image.new("RGB", (100, 100), "white").save(source)
        with self.assertRaisesRegex(TemplateConfigError, "orientation is invalid"):
            self.manager.create_from_image("bad", source, {"orientation": "diagonal"})

    def test_vertical_alignment_moves_text_down(self) -> None:
        source = self.root / "source.png"
        Image.new("RGB", (180, 300), "white").save(source)
        options = {
            "x": "60",
            "y": "20",
            "w": "60",
            "h": "250",
            "fontsize": "30",
            "orientation": "vertical",
            "color": "#000000",
        }
        top = self.manager.create_from_image(
            "top", source, {**options, "valign": "top"}
        )
        bottom = self.manager.create_from_image(
            "bottom", source, {**options, "valign": "bottom"}
        )
        renderer = TemplateRenderer(self.root / "fonts")
        top_bounds = (
            renderer.render(top, {"name": "AB"})
            .convert("L")
            .point(lambda value: 255 if value < 128 else 0)
            .getbbox()
        )
        bottom_bounds = (
            renderer.render(bottom, {"name": "AB"})
            .convert("L")
            .point(lambda value: 255 if value < 128 else 0)
            .getbbox()
        )
        self.assertIsNotNone(top_bounds)
        self.assertIsNotNone(bottom_bounds)
        self.assertGreater(bottom_bounds[1], top_bounds[1])

    def test_text_styles_and_prefill_round_trip_and_render(self) -> None:
        source = self.root / "source.png"
        Image.new("RGB", (300, 180), "white").save(source)
        options = {
            "x": "40",
            "y": "40",
            "w": "220",
            "h": "90",
            "fontsize": "40",
            "color": "#000000",
            "default": "TEST",
        }
        renderer = TemplateRenderer(self.root / "fonts")
        plain = self.manager.create_from_image("plain", source, options)
        self.assertFalse(plain.layers[0].bold)
        self.assertFalse(plain.layers[0].italic)
        self.assertFalse(plain.layers[0].underline)
        self.assertFalse(plain.layers[0].strikethrough)
        plain_image = renderer.render(plain, {})
        plain_pixels = sum(plain_image.convert("L").histogram()[:128])

        for style in ("bold", "italic", "underline", "strikethrough"):
            styled = self.manager.create_from_image(
                style, source, {**options, style: "true"}
            )
            self.assertTrue(getattr(self.manager.load(style).layers[0], style))
            self.assertEqual(styled.layers[0].default, "TEST")
            image = renderer.render(styled, {})
            self.assertNotEqual(image.tobytes(), plain_image.tobytes(), style)
            if style in {"bold", "underline", "strikethrough"}:
                pixels = sum(image.convert("L").histogram()[:128])
                self.assertGreater(pixels, plain_pixels, style)

        combined = self.manager.create_from_image(
            "combined",
            source,
            {
                **options,
                "orientation": "vertical",
                "w": "90",
                "h": "130",
                "bold": "true",
                "italic": "true",
                "underline": "true",
                "strikethrough": "true",
                "rotation": "35",
            },
        )
        self.assertIsNotNone(renderer.render(combined, {}).getbbox())

    def test_invalid_text_style_is_rejected(self) -> None:
        source = self.root / "source.png"
        Image.new("RGB", (100, 100), "white").save(source)
        with self.assertRaisesRegex(TemplateConfigError, "bold must be true or false"):
            self.manager.create_from_image("invalid", source, {"bold": "sometimes"})

    def test_rotation_round_trip_and_rendering(self) -> None:
        source = self.root / "source.png"
        Image.new("RGB", (240, 160), "white").save(source)
        common = {
            "x": "50",
            "y": "55",
            "w": "140",
            "h": "50",
            "fontsize": "40",
            "color": "#000000",
            "align": "center",
            "valign": "middle",
        }
        original = self.manager.create_from_image("plain", source, common)
        turned = self.manager.create_from_image(
            "turned", source, {**common, "rotation": "90"}
        )
        self.assertEqual(self.manager.load("turned").layers[0].rotation, 90)
        self.assertEqual(
            json.loads((self.root / "turned" / "config.json").read_text("utf-8"))[
                "layers"
            ][0]["rotation"],
            90,
        )

        renderer = TemplateRenderer(self.root / "fonts")
        plain_image = renderer.render(original, {"name": "Hello"})
        turned_image = renderer.render(turned, {"name": "Hello"})

        def dark_bounds(image: Image.Image) -> tuple[int, int, int, int]:
            grayscale = image.convert("L")
            return grayscale.point(lambda value: 255 if value < 128 else 0).getbbox()

        plain_bounds = dark_bounds(plain_image)
        turned_bounds = dark_bounds(turned_image)
        self.assertIsNotNone(plain_bounds)
        self.assertIsNotNone(turned_bounds)
        self.assertGreater(
            plain_bounds[2] - plain_bounds[0], plain_bounds[3] - plain_bounds[1]
        )
        self.assertGreater(
            turned_bounds[3] - turned_bounds[1], turned_bounds[2] - turned_bounds[0]
        )

    def test_invalid_rotation_is_rejected(self) -> None:
        source = self.root / "source.png"
        Image.new("RGB", (100, 100), "white").save(source)
        with self.assertRaises(TemplateConfigError):
            self.manager.create_from_image("bad", source, {"rotation": "not-a-number"})

    def test_narrow_box_wraps_text_without_squeezing(self) -> None:
        source = self.root / "source.png"
        Image.new("RGB", (240, 400), "white").save(source)
        template = self.manager.create_from_image(
            "narrow",
            source,
            {
                "x": "40",
                "y": "30",
                "w": "60",
                "h": "40",
                "fontsize": "32",
                "align": "left",
                "valign": "top",
            },
        )
        renderer = TemplateRenderer(self.root / "fonts")
        layer = template.layers[0]
        font = renderer._load_font(layer)
        draw = ImageDraw.Draw(Image.new("RGB", (240, 400), "white"))
        for text in ("MMMMMM", "中文中文中文"):
            lines = renderer._wrap_text(draw, text, font, layer.w)
            self.assertGreater(len(lines), 1)
            for line in lines:
                bounds = draw.textbbox((0, 0), line, font=font)
                self.assertLessEqual(bounds[2] - bounds[0], layer.w)

        word_box = draw.textbbox((0, 0), "Hello", font=font)
        word_width = word_box[2] - word_box[0]
        word_lines = renderer._wrap_text(draw, "Hello world", font, word_width)
        self.assertEqual(word_lines[0], "Hello")
        self.assertTrue(all(word_lines))

        result = renderer.render(template, {"name": "MMMMMM"})
        dark = result.convert("L").point(lambda value: 255 if value < 128 else 0)
        bounds = dark.getbbox()
        self.assertIsNotNone(bounds)
        self.assertLessEqual(bounds[2] - bounds[0], layer.w)
        self.assertGreater(bounds[3] - bounds[1], layer.fontsize * 2)


if __name__ == "__main__":
    unittest.main()
