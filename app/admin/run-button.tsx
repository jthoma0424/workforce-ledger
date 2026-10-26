'use client';

import { useFormStatus } from 'react-dom';

/** Submit button that shows "Running…" while its server action is in progress. */
export function RunButton({ label, primary }: { label: string; primary?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={primary ? '' : 'secondary'} disabled={pending}>
      {pending ? `${label}: running… (can take 1–2 min)` : label}
    </button>
  );
}
