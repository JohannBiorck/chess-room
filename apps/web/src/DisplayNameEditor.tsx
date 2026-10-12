import { displayNameSchema } from "@chess-room/contracts";
import { useEffect, useRef, useState } from "react";
import { Modal } from "./Modal";

export function DisplayNameEditor({
  displayName,
  busy,
  error,
  onSave,
  onClose,
}: {
  displayName: string;
  busy: boolean;
  error: string | null;
  onSave: (name: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [name, setName] = useState(displayName);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  const message =
    validationError ?? (failed ? (error ?? "We couldn’t save your name. Try again.") : null);
  const close = () => {
    if (!busy) onClose();
  };

  return (
    <Modal title="Change display name" onClose={close}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy) return;
          const result = displayNameSchema.safeParse(name);
          if (!result.success) {
            setValidationError("Use 1–32 characters, without control characters.");
            input.current?.focus();
            return;
          }
          setValidationError(null);
          setFailed(false);
          if (await onSave(result.data)) onClose();
          else setFailed(true);
        }}
      >
        <p>Your name is shown to the other player. Your saved seat stays in this browser.</p>
        <div className="form-field">
          <label htmlFor="new-display-name">New display name</label>
          <input
            id="new-display-name"
            ref={input}
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoComplete="nickname"
            maxLength={32}
            required
            disabled={busy}
            aria-invalid={validationError !== null}
            aria-describedby={message ? "name-error" : undefined}
          />
          {message && (
            <span className="field-error" id="name-error" role="alert">
              {message}
            </span>
          )}
        </div>
        <div className="button-row">
          <button type="button" className="button button--quiet" disabled={busy} onClick={close}>
            Cancel
          </button>
          <button type="submit" className="button button--primary" disabled={busy}>
            {busy ? "Saving name…" : "Save name"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
