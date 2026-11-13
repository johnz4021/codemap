// While the conversation is closed, a button in the map's top-left corner opens it again, at its latest reply.
import type { Dispatch } from 'react';
import type { Action, State } from './state';

export function ConversationButton({ state: s, dispatch }: { state: State; dispatch: Dispatch<Action> }) {
  const last = s.answers[s.answers.length - 1];
  if (!last) return null;
  return (
    <div className="history-corner">
      <button className="pill-btn history-btn" onClick={() => dispatch({ type: 'show', answerId: last.id })} title="Open the conversation about this map">
        Conversation <span className="muted">{s.answers.length}</span>
      </button>
    </div>
  );
}
