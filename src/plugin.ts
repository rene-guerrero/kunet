/** the KuLocal Capacitor plugin (android/ in this package), registered once for every kunet module */
import { registerPlugin } from '@capacitor/core';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const KuLocal = registerPlugin<any>('KuLocal');
