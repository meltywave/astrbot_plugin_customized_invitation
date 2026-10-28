import json
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image

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
                    "name": "legacy", "width": 120, "height": 120,
                    "layers": [{
                        "id": "name", "type": "text", "field": "name",
                        "x": 20, "y": 40, "w": 80, "h": 30, "fontsize": 20,
                    }],
                }
            ),
            encoding="utf-8",
        )
        self.assertEqual(self.manager.load("legacy").layers[0].rotation, 0)

    def test_rotation_round_trip_and_rendering(self) -> None:
        source = self.root / "source.png"
        Image.new("RGB", (240, 160), "white").save(source)
        common = {
            "x": "50", "y": "55", "w": "140", "h": "50",
            "fontsize": "40", "color": "#000000",
            "align": "center", "valign": "middle",
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
        self.assertGreater(plain_bounds[2] - plain_bounds[0], plain_bounds[3] - plain_bounds[1])
        self.assertGreater(turned_bounds[3] - turned_bounds[1], turned_bounds[2] - turned_bounds[0])

    def test_invalid_rotation_is_rejected(self) -> None:
        source = self.root / "source.png"
        Image.new("RGB", (100, 100), "white").save(source)
        with self.assertRaises(TemplateConfigError):
            self.manager.create_from_image(
                "bad", source, {"rotation": "not-a-number"}
            )


if __name__ == "__main__":
    unittest.main()
