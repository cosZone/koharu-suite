import type { Meta, StoryObj } from '@storybook/react-vite';
import { Field } from './field';
import { Input } from './input';

const meta = {
  component: Field,
  title: 'Primitives/Form',
} satisfies Meta<typeof Field>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    children: (
      <Input autoComplete="email" name="email" placeholder="owner@example.com" type="email" />
    ),
    hint: '只用于登录和安全通知。',
    label: 'Owner email',
  },
};

export const ErrorState: Story = {
  args: {
    children: (
      <Input aria-invalid="true" defaultValue="broken-address" name="invalid-email" type="email" />
    ),
    error: '请输入有效的邮箱地址。',
    label: 'Owner email',
  },
};

export const Narrow: Story = {
  args: {
    children: <Input name="reason" placeholder="例如：已修复解析器，重新处理" />,
    hint: '这段原因将写入不可变审计记录。',
    label: '操作原因',
  },
  decorators: [
    (Story) => (
      <div style={{ width: 260 }}>
        <Story />
      </div>
    ),
  ],
};
