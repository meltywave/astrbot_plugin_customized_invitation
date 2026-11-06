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

    def text_box_reset_done(self) -> bool:
        """Check whether existing template boxes were cleared.

        Returns:
            True after the one-time text box reset completes.
        """
        return self._load().get("text_box_reset_v1") is True

    def mark_text_box_reset_done(self) -> None:
        """Record completion of the one-time text box reset.

        Returns:
            None.
        """
        data = self._load()
        data["text_box_reset_v1"] = True
        self._save(data)

    def get_upload_task(self, token: str) -> dict | None:
        """Get an upload task.

        Args:
            token: Upload task token.

        Returns:
            Upload task data, or None.
        """
        task = self._load().get("upload_tasks", {}).get(token)
        return task if isinstance(task, dict) else None

    def set_upload_task_template(self, token: str, template_name: str) -> None:
        """Bind an upload task to the selected template.

        Args:
            token: Existing upload task token.
            template_name: Template identifier.

        Raises:
            ValueError: If the task no longer exists.
        """
        data = self._load()
        task = data.get("upload_tasks", {}).get(token)
        if not isinstance(task, dict):
            raise ValueError("Upload task is invalid or expired.")
        task["template_name"] = template_name
        self._save(data)

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

    def get_effective_template(self, owner_key: str) -> str | None:
        """Resolve a user's template while honoring an explicit global disable.

        Args:
            owner_key: Stable user storage key.

        Returns:
            Active template name, or None when templates are disabled.
        """
        active = self._load()["active_templates"]
        global_name = active.get("editor-global")
        if global_name == "":
            return None
        user_name = active.get(owner_key)
        if user_name is not None:
            return (
                user_name if isinstance(user_name, str) and user_name.strip() else None
            )
        return (
            global_name
            if isinstance(global_name, str) and global_name.strip()
            else None
        )

    def rename_template_references(
        self, old_name: str, new_name: str, owner_key: str | None = None
    ) -> None:
        """Update saved bindings when a template primary name changes.

        Args:
            old_name: Previous template identifier.
            new_name: New template identifier.
            owner_key: Owner of a user template, or None for a global template.

        Returns:
            None.
        """
        if old_name == new_name:
            return
        data = self._load()
        for task in data["upload_tasks"].values():
            if (
                isinstance(task, dict)
                and task.get("template_name") == old_name
                and (owner_key is None or task.get("owner_key") == owner_key)
            ):
                task["template_name"] = new_name
        for owner, name in data["active_templates"].items():
            if name == old_name and (owner_key is None or owner == owner_key):
                data["active_templates"][owner] = new_name
        self._save(data)

    def clear_template_references(
        self, template_name: str, owner_key: str | None = None
    ) -> None:
        """Clear bindings that reference a deleted template.

        Args:
            template_name: Deleted template primary name.
            owner_key: Owner of a user template, or None for a global template.

        Returns:
            None.
        """
        data = self._load()
        for task in data["upload_tasks"].values():
            if (
                isinstance(task, dict)
                and task.get("template_name") == template_name
                and (owner_key is None or task.get("owner_key") == owner_key)
            ):
                task["template_name"] = ""
        for owner, name in data["active_templates"].items():
            if name == template_name and (owner_key is None or owner == owner_key):
                data["active_templates"][owner] = ""
        self._save(data)

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
