import type { TFunction } from 'i18next'

export const EMPLOYEE_STATUS_COLOR_MAP: Record<string, string> = {
  draft: 'default',
  active: 'green',
  paused: 'orange',
  error: 'red',
}

export function getEmployeeStatusTextMap(t: TFunction): Record<string, string> {
  return {
    draft: t('employeeStatus.draft'),
    active: t('employeeStatus.running'),
    paused: t('employeeStatus.paused'),
    error: t('employeeStatus.error'),
  }
}
