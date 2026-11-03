type Handler = (payload: { patientId: string }) => void | Promise<void>;
const handlers = new Map<string, Handler[]>();

export const bus = {
  on(event: string, handler: Handler) {
    handlers.set(event, [...(handlers.get(event) ?? []), handler]);
  },
  emit(event: string, payload: { patientId: string }) {
    for (const handler of handlers.get(event) ?? []) void handler(payload);
  },
};
