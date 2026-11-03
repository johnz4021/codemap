import { db } from '../db';
import { evaluateRules } from '../automations/evaluate';

// Runs at 2:00 am, for patients created the day before.
export const schedule = '0 2 * * *';

export async function runNightly() {
  const yesterday = new Date(Date.now() - 86_400_000);
  const patients = await db.where('patients', { createdAfter: yesterday });
  for (const patient of patients) await evaluateRules({ patientId: patient.id });
}
