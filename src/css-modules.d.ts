/** 让 tsc 认识样式表导入：`*.module.css` 由 tsdown 编译成类名映射（构建期注入样式）。 */
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>
  export default classes
}
