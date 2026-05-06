import React from 'react'
import { Empty, Button, Typography } from 'antd'
import type { ButtonProps } from 'antd'

const { Text, Paragraph } = Typography

interface EmptyStateProps {
  icon?: React.ReactNode
  title: string
  description?: string
  actionText?: string
  actionProps?: ButtonProps
  onAction?: () => void
}

const EmptyState: React.FC<EmptyStateProps> = ({
  icon,
  title,
  description,
  actionText,
  actionProps = {},
  onAction,
}) => {
  return (
    <div style={{ padding: '60px 20px', textAlign: 'center' }}>
      <Empty
        image={icon || Empty.PRESENTED_IMAGE_SIMPLE}
        description={
          <div>
            <Paragraph style={{ marginBottom: 8, fontSize: 15, fontWeight: 500 }}>
              {title}
            </Paragraph>
            {description && (
              <Text type="secondary" style={{ fontSize: 13 }}>
                {description}
              </Text>
            )}
          </div>
        }
      >
        {actionText && onAction && (
          <Button type="primary" onClick={onAction} {...actionProps}>
            {actionText}
          </Button>
        )}
      </Empty>
    </div>
  )
}

export default EmptyState
