// Stopping illuminate from the page, and what a tab shows once it has stopped (by the button, Ctrl+C, or on its own).
import { api } from './api';

export function StopButton({ busy, onStopped, onError }: { busy: boolean; onStopped: () => void; onError: (message: string) => void }) {
  return (
    <button
      className="pill-btn"
      disabled={busy}
      title={busy ? 'Claude is still working' : 'Maps stay saved. Undo for applied fixes ends.'}
      onClick={() => api.stop().then(onStopped, (e: Error) => onError(e.message))}
    >
      Stop illuminate
    </button>
  );
}

export function Stopped() {
  return (
    <main className="home">
      <h1>illuminate has stopped</h1>
      <p className="muted lede">You can close this tab.</p>
      <p className="muted lede">
        Maps are saved in <code>.illuminate/maps</code>. Run <code>illume open</code> in the repo to see them again.
      </p>
    </main>
  );
}
