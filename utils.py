import shlex

from .models import InvitationRequest


def parse_invitation_fields(
    message: str,
    template_name: str,
    command_names: set[str] | None = None,
) -> InvitationRequest:
    """Parse invitation content arguments.

    Args:
        message: Raw message text.
        template_name: Selected template name.
        command_names: Command names that should be removed from the message.

    Returns:
        Parsed invitation request.

    Raises:
        ValueError: If no usable content is provided.
    """
    tokens = shlex.split(message)
    command_names = command_names or {"invitation"}
    if tokens and tokens[0].lstrip("/").lower() in command_names:
        tokens = tokens[1:]

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
        raise ValueError("Please provide content, for example: /invitation Alice")

    return InvitationRequest(template_name=template_name, fields=fields)


def parse_template_name(message: str, command_names: set[str]) -> str:
    """Parse a command with one template name argument.

    Args:
        message: Raw message text.
        command_names: Command names that should be removed from the message.

    Returns:
        Template name.

    Raises:
        ValueError: If the template name is missing.
    """
    tokens = shlex.split(message)
    if tokens and tokens[0].lstrip("/").lower() in command_names:
        tokens = tokens[1:]
    if not tokens:
        raise ValueError("Please provide a template name.")
    return tokens[0].strip()


def parse_template_options(
    message: str,
    command_names: set[str],
) -> tuple[str, dict[str, str]]:
    """Parse template management command options.

    Args:
        message: Raw message text.
        command_names: Command names that should be removed from the message.

    Returns:
        Template name and parsed key-value options.

    Raises:
        ValueError: If the template name or options are invalid.
    """
    tokens = shlex.split(message)
    if tokens and tokens[0].lstrip("/").lower() in command_names:
        tokens = tokens[1:]
    if not tokens:
        raise ValueError("Please provide a template name.")

    template_name = tokens.pop(0).strip()
    options: dict[str, str] = {}
    for token in tokens:
        if "=" not in token:
            raise ValueError(f"Invalid option: {token}. Use key=value.")
        key, value = token.split("=", 1)
        key = key.strip()
        if not key:
            raise ValueError("Option name cannot be empty.")
        options[key] = value.strip()
    return template_name, options
