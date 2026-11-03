// The patient page header: staff mark a lead as converted here.
export function PatientHeader({ patientId }: { patientId: string }) {
  const onConvert = () => fetch(`/api/patients/${patientId}/convert`, { method: 'POST' });
  return <button onClick={onConvert}>Mark as converted</button>;
}
