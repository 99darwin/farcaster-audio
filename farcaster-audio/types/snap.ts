/**
 * Farcaster Snap types — mirrors docs.farcaster.xyz/snap.
 *
 * This is the read-only subset: detection + rendering. Interactive submit
 * (JFS signing) is out of scope in this phase; buttons render disabled.
 */

export const SNAP_MEDIA_TYPE = 'application/vnd.farcaster.snap+json';

export type SnapAccent =
  | 'gray'
  | 'blue'
  | 'red'
  | 'amber'
  | 'green'
  | 'teal'
  | 'purple'
  | 'pink';

export type PaletteColor = SnapAccent | 'accent';

export type SnapEffect = 'confetti';

export interface SnapTheme {
  accent?: SnapAccent;
}

export type SnapSize = 'sm' | 'md';
export type SnapGap = 'none' | 'sm' | 'md' | 'lg';
export type SnapJustify = 'start' | 'center' | 'end' | 'between' | 'around';
export type SnapAspect = '1:1' | '16:9' | '4:3' | '9:16';
export type SnapOrientation = 'horizontal' | 'vertical';

/** Component prop shapes (props only — container children live on the element). */

export interface TextProps {
  content: string;
  size?: SnapSize;
  weight?: 'bold' | 'normal';
  align?: 'left' | 'center' | 'right';
}

export interface BadgeProps {
  label: string;
  variant?: 'default' | 'outline';
  color?: PaletteColor;
  icon?: string;
}

export interface ButtonProps {
  label: string;
  variant?: 'primary' | 'secondary';
  icon?: string;
}

export interface IconProps {
  name: string;
  color?: PaletteColor;
  size?: SnapSize;
}

export interface ImageProps {
  url: string;
  aspect: SnapAspect;
  alt?: string;
}

export interface ItemProps {
  title: string;
  description?: string;
  variant?: 'default';
}

export interface ProgressProps {
  value: number;
  max: number;
  label?: string;
}

export interface SeparatorProps {
  orientation?: SnapOrientation;
}

export interface StackProps {
  direction?: 'vertical' | 'horizontal';
  gap?: SnapGap;
  justify?: SnapJustify;
}

export interface ItemGroupProps {
  border?: boolean;
  separator?: boolean;
  gap?: SnapGap;
}

export interface BarChartBar {
  label: string;
  value: number;
  color?: PaletteColor;
}

export interface BarChartProps {
  bars: BarChartBar[];
  max?: number;
  color?: PaletteColor;
}

export interface CellGridCell {
  row: number;
  col: number;
  color?: PaletteColor;
  content?: string;
}

export interface CellGridProps {
  name?: string;
  cols: number;
  rows: number;
  cells: CellGridCell[];
  gap?: SnapGap;
  rowHeight?: number;
  select?: 'off' | 'single' | 'multiple';
}

export interface InputProps {
  name: string;
  type?: 'text' | 'number';
  label?: string;
  placeholder?: string;
  defaultValue?: string;
  maxLength?: number;
}

export interface SliderProps {
  name: string;
  min: number;
  max: number;
  step?: number;
  defaultValue?: number;
  label?: string;
}

export interface SwitchProps {
  name: string;
  label?: string;
  defaultChecked?: boolean;
}

export interface ToggleGroupProps {
  name: string;
  options: string[];
  multiple?: boolean;
  orientation?: SnapOrientation;
  defaultValue?: string | string[];
  variant?: 'default' | 'outline';
  label?: string;
}

/** Discriminated union of all components. */
export type SnapElement =
  | { type: 'text'; props: TextProps; children?: string[]; on?: SnapEvents }
  | { type: 'badge'; props: BadgeProps; children?: string[]; on?: SnapEvents }
  | { type: 'button'; props: ButtonProps; children?: string[]; on?: SnapEvents }
  | { type: 'icon'; props: IconProps; children?: string[]; on?: SnapEvents }
  | { type: 'image'; props: ImageProps; children?: string[]; on?: SnapEvents }
  | { type: 'item'; props: ItemProps; children?: string[]; on?: SnapEvents }
  | { type: 'progress'; props: ProgressProps; children?: string[]; on?: SnapEvents }
  | { type: 'separator'; props: SeparatorProps; children?: string[]; on?: SnapEvents }
  | { type: 'stack'; props: StackProps; children?: string[]; on?: SnapEvents }
  | { type: 'item_group'; props: ItemGroupProps; children?: string[]; on?: SnapEvents }
  | { type: 'bar_chart'; props: BarChartProps; children?: string[]; on?: SnapEvents }
  | { type: 'cell_grid'; props: CellGridProps; children?: string[]; on?: SnapEvents }
  | { type: 'input'; props: InputProps; children?: string[]; on?: SnapEvents }
  | { type: 'slider'; props: SliderProps; children?: string[]; on?: SnapEvents }
  | { type: 'switch'; props: SwitchProps; children?: string[]; on?: SnapEvents }
  | { type: 'toggle_group'; props: ToggleGroupProps; children?: string[]; on?: SnapEvents };

export type SnapElementType = SnapElement['type'];

export interface SnapAction {
  type: 'submit';
  [key: string]: unknown;
}

export interface SnapEvents {
  press?: SnapAction;
}

export interface SnapUi {
  root: string;
  elements: Record<string, SnapElement>;
  state?: Record<string, unknown>;
}

export interface SnapResponse {
  version: '1.0';
  theme?: SnapTheme;
  effects?: SnapEffect[];
  ui: SnapUi;
}

/** Runtime input state collected from field components. */
export type SnapInputValue = string | number | boolean | string[];
export type SnapInputs = Record<string, SnapInputValue>;
