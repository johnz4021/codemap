import express from 'express';
import { markConverted } from '../patients/service';

export const app = express();

app.post('/api/patients/:id/convert', convertPatient);

export async function convertPatient(req: { params: { id: string } }, res: { json(body: unknown): void }) {
  await markConverted(req.params.id);
  res.json({ ok: true });
}
