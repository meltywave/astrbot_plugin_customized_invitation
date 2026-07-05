import shlex

from .models import InvitationRequest


def parse_command_args(message: str, template_names: list[str]) -> InvitationRequest:
    """Parse invitation command arguments.

    Args:
        message: Raw message text.
        template_names: Available template names.

    Returns:
        Parsed invitation request.

    Raises:
        ValueError: If no usable content is provided.
    """
    tokens = shlex.split(message)
    if tokens and tokens[0].lstrip("/").lower() in {"invitation", "邀请函"}:
        tokens = tokens[1:]

    if not template_names:
        raise ValueError("没有可用模板，请先添加模板配置。")

    template_name = template_names[0]
    if tokens and tokens[0] in template_names:
        template_name = tokens.pop(0)

    fields: dict[str, str] = {}
    positional: list[str] = []
    for token in tokens:
        if "=" in token:
            key, value = token.split("=", 1)
            key = key.strip()
            if key:
                fields[key] = value.strip()
            continue
        positional.append(token)

    if positional and "name" not in fields:
        fields["name"] = " ".join(positional).strip()

    if not fields:
        raise ValueError("请提供邀请函内容，例如：/邀请函 张三 或 /邀请函 name=张三")

    return InvitationRequest(template_name=template_name, fields=fields)
