import { Slider as SliderPrimitive } from 'radix-ui'
import type * as React from 'react'

import { cn } from '@/lib/utils'

export interface SliderProps extends Omit<
  React.ComponentProps<typeof SliderPrimitive.Root>,
  'children' | 'aria-label' | 'aria-labelledby' | 'aria-valuetext'
> {
  'aria-label'?: string
  'aria-labelledby'?: string
  'aria-valuetext'?: string
}

function Slider({
  className,
  value,
  defaultValue,
  min = 0,
  disabled,
  'aria-label': label,
  'aria-labelledby': labelledBy,
  'aria-valuetext': valueText,
  ...props
}: SliderProps) {
  const values = value ?? defaultValue ?? [min]

  return (
    <SliderPrimitive.Root
      className={cn(
        'relative flex w-full touch-none items-center select-none data-[disabled]:opacity-50 data-[orientation=vertical]:h-full data-[orientation=vertical]:w-5 data-[orientation=vertical]:flex-col',
        className
      )}
      data-slot="slider"
      defaultValue={defaultValue}
      disabled={disabled}
      min={min}
      value={value}
      {...props}
    >
      <SliderPrimitive.Track
        className="relative grow overflow-hidden rounded-full bg-(--ui-stroke-tertiary) data-[orientation=horizontal]:h-1 data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-1"
        data-slot="slider-track"
      >
        <SliderPrimitive.Range
          className="absolute bg-primary data-[orientation=horizontal]:h-full data-[orientation=vertical]:w-full"
          data-slot="slider-range"
        />
      </SliderPrimitive.Track>
      {values.map((_, index) => (
        <SliderPrimitive.Thumb
          aria-disabled={disabled || undefined}
          aria-label={label}
          aria-labelledby={labelledBy}
          aria-valuetext={valueText}
          className="block size-4 cursor-pointer rounded-full border border-(--ui-stroke-secondary) bg-background shadow-sm outline-none hover:bg-(--chrome-action-hover) focus-visible:border-ring focus-visible:bg-(--chrome-action-hover) disabled:pointer-events-none"
          data-slot="slider-thumb"
          key={index}
        />
      ))}
    </SliderPrimitive.Root>
  )
}

export { Slider }
