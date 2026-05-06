import React, { useState, useCallback } from 'react'
import { Upload, Button, message, Space, Typography } from 'antd'
import { InboxOutlined, FileTextOutlined, UploadOutlined } from '@ant-design/icons'
import type { UploadProps } from 'antd'

const { Dragger } = Upload
const { Text, Paragraph } = Typography

interface FileUploadZoneProps {
  projectId: string
  onUploadSuccess?: (files: any[]) => void
  maxSize?: number
}

const SUPPORTED_TYPES = [
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.csv',
  '.txt',
  '.md',
  '.html',
  '.htm',
  '.eml',
]

const FileUploadZone: React.FC<FileUploadZoneProps> = ({
  projectId,
  onUploadSuccess,
  maxSize = 200,
}) => {
  const [uploading, setUploading] = useState(false)

  const handleFileImport = useCallback(
    async (filePaths: string[]) => {
      if (filePaths.length === 0) return

      setUploading(true)
      try {
        const result = await window.electronAPI.file.import({
          project_id: projectId,
          paths: filePaths,
        })

        if (result.imported.length > 0) {
          message.success(`成功导入 ${result.imported.length} 个文件`)
          onUploadSuccess?.(result.imported)
        }

        if (result.errors.length > 0) {
          message.warning(`${result.errors.length} 个文件导入失败`)
          console.error('Import errors:', result.errors)
        }
      } catch (error) {
        message.error('导入文件失败')
        console.error('Import error:', error)
      } finally {
        setUploading(false)
      }
    },
    [projectId, onUploadSuccess]
  )

  const handleNativeFileSelect = async () => {
    try {
      const result = await window.electronAPI.app.showOpenDialog({
        title: '选择文件',
        properties: ['openFile', 'multiSelections'],
        filters: [
          {
            name: '支持的文档类型',
            extensions: SUPPORTED_TYPES.map((t) => t.replace('.', '')),
          },
        ],
      })

      if (!result.canceled && result.filePaths.length > 0) {
        await handleFileImport(result.filePaths)
      }
    } catch (error) {
      console.error('File select error:', error)
    }
  }

  const dummyRequest: UploadProps['customRequest'] = async ({ file, onSuccess }) => {
    const fileObj = file as File & { path?: string }
    const filePath = fileObj.path || fileObj.name

    if (filePath) {
      await handleFileImport([filePath])
    }

    setTimeout(() => {
      onSuccess?.('ok')
    }, 0)
  }

  const handleDraggerClick = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (!uploading) {
      handleNativeFileSelect()
    }
  }

  return (
    <div>
      <div onClick={handleDraggerClick}>
        <Dragger
          name="file"
          multiple={true}
          directory={false}
          accept={SUPPORTED_TYPES.join(',')}
          showUploadList={false}
          customRequest={dummyRequest}
          disabled={uploading}
          style={{ padding: '30px 20px' }}
          openFileDialogOnClick={false}
        >
        <p className="ant-upload-drag-icon">
          <InboxOutlined style={{ fontSize: 48, color: '#1677ff' }} />
        </p>
        <Paragraph strong style={{ marginBottom: 4 }}>
          拖拽文件到此处上传
        </Paragraph>
        <Text type="secondary" style={{ fontSize: 13 }}>
          支持 PDF、Word、Excel、纯文本等格式，单个文件不超过 {maxSize}MB
        </Text>
        <div style={{ marginTop: 16 }}>
          <Space>
            <Button
              type="primary"
              icon={<UploadOutlined />}
              loading={uploading}
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                handleNativeFileSelect()
              }}
            >
              选择文件
            </Button>
            <Text type="secondary" style={{ fontSize: 12 }}>
              或直接拖拽文件到上方区域
            </Text>
          </Space>
        </div>
        </Dragger>
      </div>

      <div
        style={{
          marginTop: 12,
          display: 'flex',
          gap: 16,
          flexWrap: 'wrap',
        }}
      >
        {SUPPORTED_TYPES.slice(0, 8).map((type) => (
          <Space key={type} size={4}>
            <FileTextOutlined style={{ fontSize: 12, color: '#999' }} />
            <Text type="secondary" style={{ fontSize: 12 }}>
              {type}
            </Text>
          </Space>
        ))}
      </div>
    </div>
  )
}

export default FileUploadZone
