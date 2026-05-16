import { Tag } from 'antd'
import { DatabaseOutlined } from '@ant-design/icons'

interface KBTagListProps {
  kbs: Array<{ id: string; name: string; doc_count?: number }>
}

const KBTagList: React.FC<KBTagListProps> = ({ kbs }) => {
  if (!kbs || kbs.length === 0) return null
  return (
    <>
      {kbs.map(kb => (
        <Tag key={kb.id} icon={<DatabaseOutlined />} color="purple">
          {kb.name}
        </Tag>
      ))}
    </>
  )
}

export default KBTagList
