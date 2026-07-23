import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { Button } from './button';

const meta = {
  args: {
    children: '保存更改',
    type: 'button',
  },
  component: Button,
  title: 'Primitives/Button',
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Primary: Story = {};

export const Variants: Story = {
  render: () => (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
      <Button type="button" variant="primary">
        发布 Preview
      </Button>
      <Button type="button" variant="quiet">
        稍后处理
      </Button>
      <Button type="button" variant="danger">
        显式跳过
      </Button>
    </div>
  ),
};

export const Disabled: Story = {
  args: {
    disabled: true,
  },
};

export const KeyboardFocus: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.tab();
    await expect(canvas.getByRole('button', { name: '保存更改' })).toHaveFocus();
  },
};

export const Inverse: Story = {
  decorators: [
    (Story) => (
      <div data-koharu-ui-tone="inverse" style={{ padding: 24 }}>
        <Story />
      </div>
    ),
  ],
};
