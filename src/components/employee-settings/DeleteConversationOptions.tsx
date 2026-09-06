import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Checkbox, Radio, Select, Typography, theme } from 'antd'

const { Text } = Typography

export interface DeleteConversationState {
  conversationAction: 'keep' | 'delete' | 'transfer'
  transferToEmployeeId?: string
  deleteWorkspace: boolean
}

/** 删除员工时选择对话历史处理方式（保留/删除/转移），状态实时上报给调用方 */
function DeleteConversationOptions({
  targets,
  showWorkspace,
  onStateChange,
}: {
  targets: Array<{ id: string; name: string }>
  showWorkspace: boolean
  onStateChange: (state: DeleteConversationState) => void
}) {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [conversationAction, setConversationAction] = useState<'keep' | 'delete' | 'transfer'>('keep')
  const [transferToEmployeeId, setTransferToEmployeeId] = useState<string | undefined>()
  const [deleteWorkspace, setDeleteWorkspace] = useState(true)

  const report = (action: typeof conversationAction, transferId?: string, delWorkspace?: boolean) => {
    onStateChange({
      conversationAction: action,
      transferToEmployeeId: transferId,
      deleteWorkspace: delWorkspace ?? deleteWorkspace,
    })
  }

  return (
    <div>
      <Text type="secondary" style={{ display: 'block', marginBottom: 8, fontSize: 13 }}>
        {t('employeeSettings.conversationActionLabel')}
      </Text>
      <Radio.Group
        value={conversationAction}
        onChange={(e) => {
          const action = e.target.value as typeof conversationAction
          setConversationAction(action)
          report(action, transferToEmployeeId)
        }}
        style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
      >
        <Radio value="keep">
          <Text style={{ fontSize: 13 }}>{t('employeeSettings.conversationKeep')}</Text>
          <Text type="secondary" style={{ display: 'block', fontSize: 12 }}>{t('employeeSettings.conversationKeepHint')}</Text>
        </Radio>
        <Radio value="delete">
          <Text style={{ fontSize: 13 }}>{t('employeeSettings.conversationDelete')}</Text>
          <Text type="secondary" style={{ display: 'block', fontSize: 12 }}>{t('employeeSettings.conversationDeleteHint')}</Text>
        </Radio>
        <Radio value="transfer">
          <Text style={{ fontSize: 13 }}>{t('employeeSettings.conversationTransfer')}</Text>
          <Text type="secondary" style={{ display: 'block', fontSize: 12 }}>{t('employeeSettings.conversationTransferHint')}</Text>
        </Radio>
      </Radio.Group>
      {conversationAction === 'transfer' && (
        <Select
          style={{ width: '100%', marginTop: 10 }}
          placeholder={t('employeeSettings.transferTargetPlaceholder')}
          value={transferToEmployeeId}
          onChange={(v) => {
            setTransferToEmployeeId(v)
            report('transfer', v)
          }}
          showSearch
          optionFilterProp="label"
          options={targets.map((e) => ({ label: e.name, value: e.id }))}
        />
      )}
      {showWorkspace && conversationAction !== 'transfer' && (
        <Checkbox
          checked={deleteWorkspace}
          onChange={(e) => {
            setDeleteWorkspace(e.target.checked)
            report(conversationAction, transferToEmployeeId, e.target.checked)
          }}
          style={{ marginTop: 12 }}
        >
          {t('employeeSettings.alsoDeleteWorkspace')}
        </Checkbox>
      )}
      {conversationAction === 'transfer' && (
        <div style={{ marginTop: 12, fontSize: 12, color: token.colorTextTertiary }}>
          {t('employeeSettings.transferWorkspaceHint')}
        </div>
      )}
    </div>
  )
}

export default DeleteConversationOptions