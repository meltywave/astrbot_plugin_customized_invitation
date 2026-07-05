# AGENTS.md

## Project

This repository is an AstrBot plugin for generating invitation or template-based images from user input.

The current codebase is still close to the AstrBot hello-world template. When adding features, keep changes incremental and avoid turning `main.py` into a large all-in-one module.

## Core Principles

- Prefer configuration-driven behavior over hard-coded template logic.
- Keep templates data-driven and backward compatible.
- Keep rendering, command parsing, template management, and web editing responsibilities separate.
- Add focused modules when behavior grows beyond the plugin entry point.
- Do not expose raw tracebacks to end users.

## Expected Architecture

Use this direction as the project grows:

```text
main.py          AstrBot entry point and command handlers
renderer.py      Image rendering logic
manager.py       Template loading and validation
models.py        Typed data structures
utils.py         Shared helpers
templates/       Template assets and config files
web/             Optional editor UI
fonts/           Optional local fonts
```

Do not place all rendering, parsing, and storage logic in `main.py`.

## Template Model

Each template should live in its own directory, for example:

```text
templates/wedding/
  bg.png
  config.json
```

Template coordinates, text boxes, fonts, colors, and layer settings should come from `config.json`. Avoid hard-coding template names, positions, or special cases in Python.

Prefer a layer-based config structure:

```json
{
  "name": "wedding",
  "width": 1920,
  "height": 1080,
  "layers": [
    {
      "id": "username",
      "type": "text",
      "field": "name",
      "x": 520,
      "y": 430,
      "w": 500,
      "h": 90,
      "font": "msyh.ttc",
      "fontsize": 54,
      "align": "center",
      "valign": "middle",
      "color": "#ffffff"
    }
  ]
}
```

## Rendering

- The command handler parses user input and selects data.
- The template manager loads and validates template config.
- The renderer receives a template plus data and returns an image.
- Use `ImageDraw.textbbox()` for text measurement.
- Support left, center, right, top, middle, and bottom alignment for text layers.
- Dispatch by layer type instead of writing one large renderer function.

Initial layer support may be limited to `text`; future layer types can include `image`, `avatar`, `qrcode`, `logo`, and `shape`.

## Command Design

Start simple, but keep parsing extensible:

```text
邀请函 张三
邀请函 wedding 张三
邀请函 姓名=张三 日期=7月20日 地点=上海
```

Do not design the parser around only one command shape if the feature being added clearly needs structured fields.

## Error Handling

User mistakes should return clear messages and should not crash the plugin.

Handle at least:

- Missing template.
- Missing required field.
- Missing font, preferably with a fallback.
- Broken or unreadable image files.
- Invalid template config.

Log technical details for maintainers, but return concise user-facing messages.

## Coding Standards

- Follow existing AstrBot plugin patterns.
- Use Python type hints for new code.
- Use `dataclass` or typed models for template data when useful.
- Keep functions small and single-purpose.
- Avoid large conditional blocks for template-specific behavior.
- Preserve existing template config compatibility when changing config format.

## Tests

Add or update tests for changes that affect:

- Template config loading.
- Layer parsing.
- Text rendering and alignment.
- Command parsing.
- Backward compatibility of existing templates.

If tests cannot be run in the local environment, mention that clearly in the final response.

At the end of each response, output the files edited in this operation, including CRUD.

Only allowed to edit content in data\plugins\astrbot_plugin_customized_invitation.