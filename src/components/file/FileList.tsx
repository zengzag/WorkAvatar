import React from 'react'
import { Table, Button, Space, Tag, Typography, Popconfirm, message } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  FileTextOutlined,
  DeleteOutlined,
  SyncOutlined,
  EyeOutlined,
  CheckCircleOutlined,
  LoadingOutlined,
  ExclamationCircleOutlined,
} from '@ant-design/icons'
import { useNavigate, useParams } from 'react-router-dom'
import dayjs from 'dayjs'
import { filesize } from 'filesize'
import type { File } from '../../types'

interface FileListProps {
  files: File[]
  loading?: boolean
  onParseFile?: (fileId: string) => void
  onDeleteFile?: (fileId: string) => void
  onViewFile?: (file: File) => void
}

const FileList: React.FC<FileListProps> = ({
  files,
  loading = false,
  onParseFile,
  onDeleteFile,
  onViewFile,
}) => {
  const navigate = useNavigate()
  const { id: projectId } = useParams<{ id: string }>()
  const getStatusConfig = (status: File['status']) => {
    switch (status) {
      case 'pending':
        return { color: 'default' as const, icon: <SyncOutlined />, text: '待解析' }
      case 'parsing':
        return { color: 'processing' as const, icon: <LoadingOutlined spin />, text: '解析中' }
      case 'completed':
        return { color: 'success' as const, icon: <CheckCircleOutlined />, text: '已完成' }
      case 'failed':
        return {
          color: 'error' as const,
          icon: <ExclamationCircleOutlined />,
          text: '解析失败',
        }
      default:
        return { color: 'default' as const, icon: <SyncOutlined />, text: status }
    }
  }

  const handleParse = async (file: File) => {
    try {
      await onParseFile?.(file.id)
      message.success(`开始解析: ${file.original_name}`)
    } catch (error) {
      message.error('解析失败')
    }
  }

  const columns: ColumnsType<File> = [
    {
      title: '文件名',
      dataIndex: 'original_name',
      key: 'original_name',
      ellipsis: true,
      render: (text, record) => (
        <Space>
          <FileTextOutlined style={{ color: '#1677ff' }} />
          <Typography.Text
            ellipsis
            style={{ maxWidth: 300, cursor: 'pointer', color: '#1677ff' }}
            onClick={() => {
              if (record.status === 'completed') {
                navigate(`/project/${projectId}/file/${record.id}`)
              }
            }}
          >
            {text}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '类型',
      dataIndex: 'type',
      key: 'type',
      width: 80,
      render: (type) => <Tag color="blue">{type.toUpperCase()}</Tag>,
    },
    {
      title: '大小',
      dataIndex: 'size',
      key: 'size',
      width: 100,
      render: (size) => filesize(size, { standard: 'jedec' }),
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (status: File['status']) => {
        const config = getStatusConfig(status)
        return (
          <Tag icon={config.icon} color={config.color}>
            {config.text}
          </Tag>
        )
      },
    },
    {
      title: '规则数量',
      dataIndex: 'rule_count',
      key: 'rule_count',
      width: 90,
      render: (count) => count || 0,
    },
    {
      title: '添加时间',
      dataIndex: 'created_at',
      key: 'created_at',
      width: 160,
      render: (timestamp) => dayjs.unix(timestamp).format('YYYY-MM-DD HH:mm'),
    },
    {
      title: '操作',
      key: 'actions',
      width: 160,
      fixed: 'right' as const,
      render: (_, record) => (
        <Space size="small">
          {(record.status as string) === 'pending' || (record.status as string) === 'failed' ? (
            <Button
              type="link"
              size="small"
              icon={<SyncOutlined />}
              onClick={() => handleParse(record)}
              disabled={(record.status as string) === 'parsing'}
            >
              解析
            </Button>
          ) : (
            <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => onViewFile?.(record)}>
              预览
            </Button>
          )}
          <Popconfirm
            title="确认删除"
            description={`确定要删除文件 "${record.original_name}" 吗？`}
            onConfirm={() => onDeleteFile?.(record.id)}
            okText="确定"
            cancelText="取消"
          >
            <Button type="link" size="small" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <Table
      columns={columns}
      dataSource={files}
      rowKey="id"
      loading={loading}
      pagination={{
        pageSize: 10,
        showSizeChanger: true,
        showTotal: (total) => `共 ${total} 个文件`,
      }}
      scroll={{ x: 'max-content' }}
    />
  )
}

export default FileList
