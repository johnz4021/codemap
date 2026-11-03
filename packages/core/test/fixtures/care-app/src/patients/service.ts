import { db } from '../db';
import { bus } from '../events/bus';

export async function markConverted(patientId: string) {
  await db.update('patients', { id: patientId, status: 'enrolled' });
  bus.emit('patient.converted', { patientId });
}
