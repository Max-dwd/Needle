'use client';

import IntentManagement from '@/components/IntentManagement';
import type { ShowToast } from './shared';

interface IntentTabProps {
  showToast: ShowToast;
}

export default function IntentTab({ showToast }: IntentTabProps) {
  return (
    <div className="settings-section-wrapper animate-in fade-in slide-in-from-bottom-4 duration-300">
      <IntentManagement showToast={showToast} />
    </div>
  );
}
