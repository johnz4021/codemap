import { db } from '../db';
import { queueEmail } from '../jobs/queue';

export async function evaluateRules({ patientId }: { patientId: string }) {
  const rules = await db.where('automation_rules', { trigger: 'converted' });
  for (const rule of rules) if (rule.action === 'welcome_email') await queueEmail(patientId, rule.template);
}
