import { fireEvent, screen, within } from "@testing-library/react";

/** 从已展开的列表读取选项，覆盖真实交互入口。 */
export function openOptions(label: string) {
  fireEvent.click(screen.getByLabelText(label, { selector: "button" }));
  return within(screen.getByRole("listbox"));
}

export function chooseOption(label: string, value: string) {
  const option = openOptions(label).getAllByRole("option")
    .find((element) => element.getAttribute("value") === value);
  if (!option) throw new Error(`找不到「${label}」的选项「${value}」`);
  fireEvent.click(option);
}
