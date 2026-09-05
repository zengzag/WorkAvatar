import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Card,
  Switch,
  Alert,
  Typography,
  Checkbox,
  Tag,
  Avatar,
  App,
  theme,
} from 'antd'
import { TeamOutlined, RobotOutlined } from '@ant-design/icons'
import type { Employee } from '../../types'
import { parseEmployeeDelegation, type EmployeeDelegationConfig } from '../../types'

const { Text, Paragraph } = Typography

interface DelegationSectionProps {
  employeeId: string
  delegation: EmployeeDelegationConfig
  onSaved: () => void
}

/** 委托能力设置：发起委托（可委托员工选择）+ 接受委托，变更即时保存 */
const DelegationSection: React.FC<DelegationSectionProps> = ({
  employeeId,
  delegation,
  onSaved,
}) => {
  const { t } = useTranslation()
  const { message } = App.useApp()
  const { token } = theme.useToken()
  const [employees, setEmployees] = useState<Employee[]>([])
  const [config, setConfig] = useState<EmployeeDelegationConfig>(delegation)

  useEffect(() => {
    setConfig(delegation)
  }, [delegation])

  useEffect(() => {
    window.electronAPI.employee.list()
      .then((list: Employee[] | null) => {
        setEmployees((list || []).filter((e) => e.id !== employeeId))
      })
      .catch(() => {})
  }, [employeeId])

  /** 候选员工：id、名称、描述、是否接受被委托 */
  const candidates = useMemo(
    () => employees.map((e) => ({
      id: e.id,
      name: e.name,
      description: e.description,
      accepting: parseEmployeeDelegation(e.delegation_json).acceptDelegation,
    })),
    [employees],
  )

  const save = useCallback(async (next: EmployeeDelegationConfig) => {
    setConfig(next)
    try {
      await window.electronAPI.employee.update({
        id: employeeId,
        delegation_json: JSON.stringify(next),
      })
      message.success(t('common.saveSuccess'))
      onSaved()
    } catch {
      message.error(t('common.saveFailed'))
    }
  }, [employeeId, message, t, onSaved])

  const handleToggleEnabled = (enabled: boolean) => {
    save({ ...config, enabled })
  }

  const handleToggleAccept = (acceptDelegation: boolean) => {
    save({ ...config, acceptDelegation })
  }

  const handleToggleTarget = (targetId: string, checked: boolean) => {
    const targetIds = checked
      ? [...config.targetIds, targetId]
      : config.targetIds.filter((id) => id !== targetId)
    save({ ...config, enabled: true, targetIds })
  }

  const rowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '10px 14px',
    borderRadius: 8,
    border: `1px solid ${token.colorBorderSecondary}`,
    background: token.colorBgContainer,
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card
        title={
          <span>
            <TeamOutlined style={{ marginRight: 8, color: token.colorPrimary }} />
            {t('employeeSettings.delegationTitle')}
          </span>
        }
        extra={
          <Switch
            checked={config.enabled}
            onChange={handleToggleEnabled}
            checkedChildren={t('employeeSettings.delegationOn')}
            unCheckedChildren={t('employeeSettings.delegationOff')}
          />
        }
      >
        {!config.enabled ? (
          <Alert
            type="info"
            title={t('employeeSettings.delegationDisabledHint')}
            showIcon
          />
        ) : (
          <>
            <Text type="secondary" style={{ display: 'block', marginBottom: 12, fontSize: 12 }}>
              {t('employeeSettings.delegationTargetsHint')}
            </Text>
            {candidates.length === 0 ? (
              <Text type="secondary">{t('employeeSettings.noEmployeesForDelegation')}</Text>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {candidates.map((c) => {
                  const checked = config.targetIds.includes(c.id)
                  return (
                    <div key={c.id} style={{ ...rowStyle, opacity: c.accepting ? 1 : 0.6 }}>
                      <Checkbox
                        checked={checked}
                        disabled={!c.accepting}
                        onChange={(e) => handleToggleTarget(c.id, e.target.checked)}
                      />
                      <Avatar
                        size={32}
                        icon={<RobotOutlined />}
                        style={{ backgroundColor: token.colorPrimaryBg, color: token.colorPrimary, flexShrink: 0 }}
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <Text strong style={{ fontSize: 13 }}>{c.name}</Text>
                          {checked && !c.accepting && (
                            <Tag color="warning" style={{ margin: 0 }}>
                              {t('employeeSettings.targetNotAcceptingSelected')}
                            </Tag>
                          )}
                          {!c.accepting && (
                            <Tag style={{ margin: 0 }}>
                              {t('employeeSettings.targetNotAccepting')}
                            </Tag>
                          )}
                        </div>
                        {c.description && (
                          <Paragraph
                            type="secondary"
                            style={{ margin: 0, fontSize: 12 }}
                            ellipsis={{ rows: 1 }}
                          >
                            {c.description}
                          </Paragraph>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </>
        )}
      </Card>

      <Card
        title={t('employeeSettings.acceptDelegationTitle')}
        extra={
          <Switch
            checked={config.acceptDelegation}
            onChange={handleToggleAccept}
            checkedChildren={t('employeeSettings.delegationOn')}
            unCheckedChildren={t('employeeSettings.delegationOff')}
          />
        }
      >
        <Text type="secondary" style={{ fontSize: 13 }}>
          {t('employeeSettings.acceptDelegationHint')}
        </Text>
      </Card>
    </div>
  )
}

export default React.memo(DelegationSection)
