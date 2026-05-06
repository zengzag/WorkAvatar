import React from 'react'
import { Button, Typography, Space, Breadcrumb } from 'antd'
import { ArrowLeftOutlined } from '@ant-design/icons'

const { Title } = Typography

interface PageHeaderProps {
  title: string
  subTitle?: string
  onBack?: () => void
  extra?: React.ReactNode
  breadcrumb?: Array<{ title: string; path?: string; onClick?: () => void }>
}

const PageHeader: React.FC<PageHeaderProps> = ({ title, subTitle, onBack, extra, breadcrumb }) => {
  return (
    <div style={{ marginBottom: 24 }}>
      {breadcrumb && breadcrumb.length > 0 && (
        <Breadcrumb
          style={{ marginBottom: 12 }}
          items={breadcrumb.map((item) => ({
            title: item.title,
            ...(item.onClick ? { onClick: item.onClick } : {}),
          }))}
        />
      )}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Space>
          {onBack && (
            <Button
              type="text"
              icon={<ArrowLeftOutlined />}
              onClick={onBack}
              style={{ padding: '4px 8px' }}
            />
          )}
          <div>
            <Title level={4} style={{ margin: 0 }}>
              {title}
            </Title>
            {subTitle && (
              <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                {subTitle}
              </Typography.Text>
            )}
          </div>
        </Space>
        {extra && <div>{extra}</div>}
      </div>
    </div>
  )
}

export default PageHeader
