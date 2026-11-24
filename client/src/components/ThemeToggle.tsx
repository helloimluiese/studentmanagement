import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { themeOptions, useTheme } from "@/components/theme-provider";

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  return (
    <div className="flex flex-col gap-1.5 sm:min-w-40">
      <label htmlFor="system-appearance" className="text-sm font-medium text-foreground">
        App appearance
      </label>
      <Select
        value={theme}
        onValueChange={(selected) => {
          const option = themeOptions.find(({ value }) => value === selected);
          if (option) setTheme(option.value);
        }}
      >
        <SelectTrigger id="system-appearance" className="h-11 gap-2 rounded-full bg-background px-3.5">
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="z-[10020]">
          {themeOptions.map(({ value, label }) => (
            <SelectItem key={value} value={value}>{label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
