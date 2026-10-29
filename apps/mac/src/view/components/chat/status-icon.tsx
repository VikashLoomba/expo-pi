import { CircleAlertIcon, CircleCheckIcon, LoaderCircleIcon } from 'lucide-react';

/** A step's state on its Trace line, as the chatbot template's StatusIcon: spinning while it runs, alert if failed. */
export function StatusIcon({ status }: { status?: 'running' | 'error' }) {
  if (status === 'running') return <LoaderCircleIcon className="animate-spin" />;
  if (status === 'error') return <CircleAlertIcon />;
  return <CircleCheckIcon />;
}
