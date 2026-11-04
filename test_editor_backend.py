import json
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image, ImageDraw

PLUGIN_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(PLUGIN_DIR.parent))

from astrbot_plugin_customized_invitation.manager import (  # noqa: E402
    TemplateConfigError,
    TemplateManager,
)
from astrbot_plugin_customized_invitation.renderer import TemplateRenderer  # noqa: E402


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
