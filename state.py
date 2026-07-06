import json
import time
from pathlib import Path
from uuid import uuid4


class InvitationState:
    def __init__(self, state_path: Path):
        self.state_path = state_path

    def create_upload_task(self, owner_key: str, template_name: str) -> str:
        """Create a template upload task.

        Args:
            owner_key: Stable user storage key.
            template_name: User-visible template name.

        Returns:
            Upload task token.
        """
        data = self._load()
        token = uuid4().hex
        data.setdefault("upload_tasks", {})[token] = {
            "owner_key": owner_key,
            "template_name": template_name,
            "created_at": int(time.time()),
        }
        self._save(data)
        return token

    def get_upload_task(self, token: str) -> dict | None:
        """Get an upload task.

        Args:
            token: Upload task token.

        Returns:
            Upload task data, or None.
        """
        task = self._load().get("upload_tasks", {}).get(token)
        return task if isinstance(task, dict) else None

    def set_active_template(self, owner_key: str, template_name: str) -> None:
        """Set the active template for a user.

        Args:
            owner_key: Stable user storage key.
            template_name: User-visible template name.
        """
        data = self._load()
        data.setdefault("active_templates", {})[owner_key] = template_name
        self._save(data)

    def get_active_template(self, owner_key: str) -> str | None:
        """Get the active template for a user.

        Args:
            owner_key: Stable user storage key.

        Returns:
            Template name, or None.
        """
        value = self._load().get("active_templates", {}).get(owner_key)
        return value if isinstance(value, str) and value.strip() else None

    def _load(self) -> dict:
        """Load plugin state.

        Returns:
            State dictionary.
        """
        if not self.state_path.is_file():
            return {"upload_tasks": {}, "active_templates": {}}
        try:
            with self.state_path.open("r", encoding="utf-8") as file:
                data = json.load(file)
        except (json.JSONDecodeError, OSError):
            return {"upload_tasks": {}, "active_templates": {}}
        if not isinstance(data, dict):
            return {"upload_tasks": {}, "active_templates": {}}
        data.setdefault("upload_tasks", {})
        data.setdefault("active_templates", {})
        return data

    def _save(self, data: dict) -> None:
        """Save plugin state.

        Args:
            data: State dictionary.
        """
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        with self.state_path.open("w", encoding="utf-8") as file:
            json.dump(data, file, ensure_ascii=False, indent=2)
            file.write("\n")
