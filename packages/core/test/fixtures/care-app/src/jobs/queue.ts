import { sendEmail } from '../email/send';

export async function queueEmail(patientId: string, template: string) {
  await sendEmail(patientId, template);
}
