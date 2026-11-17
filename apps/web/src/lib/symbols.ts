/** 符号面板数据：[命令, 关键词(中英, 用于搜索), 需要的宏包?] */
export type SymbolDef = [command: string, keywords: string, pkg?: string];

export interface SymbolCategory {
  id: 'greek' | 'operators' | 'relations' | 'arrows' | 'delimiters' | 'misc' | 'accents';
  symbols: SymbolDef[];
}

export const SYMBOL_CATEGORIES: SymbolCategory[] = [
  {
    id: 'greek',
    symbols: [
      ['\\alpha', 'alpha 阿尔法'], ['\\beta', 'beta 贝塔'], ['\\gamma', 'gamma 伽马'], ['\\delta', 'delta 德尔塔'],
      ['\\epsilon', 'epsilon'], ['\\varepsilon', 'varepsilon epsilon'], ['\\zeta', 'zeta'], ['\\eta', 'eta'],
      ['\\theta', 'theta 西塔'], ['\\vartheta', 'vartheta theta'], ['\\iota', 'iota'], ['\\kappa', 'kappa'],
      ['\\lambda', 'lambda 兰姆达'], ['\\mu', 'mu 缪'], ['\\nu', 'nu'], ['\\xi', 'xi'], ['\\pi', 'pi 派'],
      ['\\varpi', 'varpi pi'], ['\\rho', 'rho'], ['\\varrho', 'varrho rho'], ['\\sigma', 'sigma 西格玛'],
      ['\\varsigma', 'varsigma sigma'], ['\\tau', 'tau'], ['\\upsilon', 'upsilon'], ['\\phi', 'phi'],
      ['\\varphi', 'varphi phi'], ['\\chi', 'chi'], ['\\psi', 'psi'], ['\\omega', 'omega 欧米伽'],
      ['\\Gamma', 'Gamma'], ['\\Delta', 'Delta'], ['\\Theta', 'Theta'], ['\\Lambda', 'Lambda'], ['\\Xi', 'Xi'],
      ['\\Pi', 'Pi'], ['\\Sigma', 'Sigma'], ['\\Upsilon', 'Upsilon'], ['\\Phi', 'Phi'], ['\\Psi', 'Psi'], ['\\Omega', 'Omega'],
    ],
  },
  {
    id: 'operators',
    symbols: [
      ['\\sum', 'sum 求和'], ['\\prod', 'product 求积'], ['\\coprod', 'coproduct'], ['\\int', 'integral 积分'],
      ['\\iint', 'double integral 二重积分', 'amsmath'], ['\\iiint', 'triple integral 三重积分', 'amsmath'], ['\\oint', 'contour integral 环路积分'],
      ['\\bigcup', 'union 并'], ['\\bigcap', 'intersection 交'], ['\\bigoplus', 'direct sum 直和'], ['\\bigotimes', 'tensor product 张量积'],
      ['\\pm', 'plus minus 正负'], ['\\mp', 'minus plus'], ['\\times', 'times 乘'], ['\\div', 'divide 除'], ['\\cdot', 'dot 点乘'],
      ['\\ast', 'asterisk 星号'], ['\\star', 'star'], ['\\circ', 'compose 复合'], ['\\bullet', 'bullet'], ['\\oplus', 'oplus 异或'],
      ['\\ominus', 'ominus'], ['\\otimes', 'otimes 张量'], ['\\odot', 'odot 哈达玛'], ['\\cup', 'union 并集'], ['\\cap', 'intersection 交集'],
      ['\\setminus', 'set minus 差集'], ['\\wedge', 'wedge and 与'], ['\\vee', 'vee or 或'], ['\\nabla', 'nabla 梯度'],
      ['\\partial', 'partial 偏导'], ['\\sqrt{x}', 'square root 根号'], ['\\frac{a}{b}', 'fraction 分数'], ['\\lim', 'limit 极限'],
      ['\\max', 'max 最大'], ['\\min', 'min 最小'], ['\\sup', 'sup 上确界'], ['\\inf', 'inf 下确界'], ['\\arg', 'arg'],
      ['\\log', 'log 对数'], ['\\ln', 'ln 自然对数'], ['\\exp', 'exp 指数'], ['\\sin', 'sin'], ['\\cos', 'cos'], ['\\tan', 'tan'], ['\\det', 'det 行列式'],
    ],
  },
  {
    id: 'relations',
    symbols: [
      ['=', 'equal 等于'], ['\\neq', 'not equal 不等于'], ['<', 'less 小于'], ['>', 'greater 大于'], ['\\leq', 'less equal 小于等于'],
      ['\\geq', 'greater equal 大于等于'], ['\\ll', 'much less 远小于'], ['\\gg', 'much greater 远大于'], ['\\approx', 'approx 约等于'],
      ['\\sim', 'similar 相似'], ['\\simeq', 'simeq'], ['\\cong', 'congruent 全等'], ['\\equiv', 'equivalent 恒等'], ['\\propto', 'proportional 正比'],
      ['\\doteq', 'doteq'], ['\\triangleq', 'defined as 定义为', 'amssymb'], ['\\coloneqq', 'coloneqq 定义', 'mathtools'],
      ['\\in', 'in 属于'], ['\\notin', 'not in 不属于'], ['\\ni', 'contains'], ['\\subset', 'subset 子集'], ['\\subseteq', 'subseteq 子集'],
      ['\\supset', 'superset 超集'], ['\\supseteq', 'supseteq'], ['\\subsetneq', 'proper subset 真子集', 'amssymb'],
      ['\\perp', 'perpendicular 垂直'], ['\\parallel', 'parallel 平行'], ['\\mid', 'divides 整除'], ['\\nmid', 'not divides', 'amssymb'],
      ['\\vdash', 'proves'], ['\\models', 'models'], ['\\prec', 'precedes'], ['\\succ', 'succeeds'], ['\\preceq', 'preceq'], ['\\succeq', 'succeq'],
      ['\\lesssim', 'less sim', 'amssymb'], ['\\gtrsim', 'greater sim', 'amssymb'],
    ],
  },
  {
    id: 'arrows',
    symbols: [
      ['\\rightarrow', 'right arrow 右箭头'], ['\\leftarrow', 'left arrow 左箭头'], ['\\leftrightarrow', 'left right arrow 双向'],
      ['\\Rightarrow', 'implies 推出'], ['\\Leftarrow', 'implied by'], ['\\Leftrightarrow', 'iff 当且仅当'], ['\\to', 'to 趋于'],
      ['\\mapsto', 'maps to 映射'], ['\\longrightarrow', 'long right arrow'], ['\\longleftarrow', 'long left arrow'],
      ['\\Longrightarrow', 'long implies'], ['\\Longleftrightarrow', 'long iff'], ['\\uparrow', 'up arrow 上箭头'],
      ['\\downarrow', 'down arrow 下箭头'], ['\\updownarrow', 'up down'], ['\\Uparrow', 'Up'], ['\\Downarrow', 'Down'],
      ['\\nearrow', 'north east'], ['\\searrow', 'south east'], ['\\swarrow', 'south west'], ['\\nwarrow', 'north west'],
      ['\\hookrightarrow', 'hook right 嵌入'], ['\\rightharpoonup', 'harpoon'], ['\\rightleftharpoons', 'equilibrium 可逆'],
      ['\\xrightarrow{f}', 'extensible arrow 带标注箭头', 'amsmath'], ['\\leadsto', 'leads to', 'amssymb'],
    ],
  },
  {
    id: 'delimiters',
    symbols: [
      ['\\left( x \\right)', 'parentheses 圆括号'], ['\\left[ x \\right]', 'brackets 方括号'], ['\\left\\{ x \\right\\}', 'braces 花括号'],
      ['\\langle x \\rangle', 'angle brackets 尖括号'], ['\\lvert x \\rvert', 'absolute value 绝对值', 'amsmath'],
      ['\\lVert x \\rVert', 'norm 范数', 'amsmath'], ['\\lfloor x \\rfloor', 'floor 向下取整'], ['\\lceil x \\rceil', 'ceil 向上取整'],
      ['\\binom{n}{k}', 'binomial 组合数', 'amsmath'], ['\\underbrace{x}_{a}', 'underbrace 下括号'], ['\\overbrace{x}^{a}', 'overbrace 上括号'],
    ],
  },
  {
    id: 'accents',
    symbols: [
      ['\\hat{a}', 'hat 帽子'], ['\\widehat{ab}', 'wide hat'], ['\\bar{a}', 'bar 均值'], ['\\overline{ab}', 'overline 上划线'],
      ['\\tilde{a}', 'tilde 波浪'], ['\\widetilde{ab}', 'wide tilde'], ['\\vec{a}', 'vector 向量'], ['\\dot{a}', 'dot 导数'],
      ['\\ddot{a}', 'double dot 二阶导'], ['\\acute{a}', 'acute'], ['\\grave{a}', 'grave'], ['\\check{a}', 'check'], ['\\breve{a}', 'breve'],
      ['\\underline{a}', 'underline 下划线'], ['\\mathbf{A}', 'bold 粗体'], ['\\boldsymbol{\\alpha}', 'bold symbol 粗体希腊', 'amsmath'],
      ['\\mathbb{R}', 'blackboard 实数集', 'amssymb'], ['\\mathcal{L}', 'calligraphic 花体'], ['\\mathfrak{g}', 'fraktur 哥特', 'amssymb'],
      ['\\mathrm{d}', 'roman 正体'], ['\\mathscr{F}', 'script 手写体', 'mathrsfs'],
    ],
  },
  {
    id: 'misc',
    symbols: [
      ['\\infty', 'infinity 无穷'], ['\\forall', 'for all 任意'], ['\\exists', 'exists 存在'], ['\\nexists', 'not exists 不存在', 'amssymb'],
      ['\\emptyset', 'empty set 空集'], ['\\varnothing', 'empty set 空集', 'amssymb'], ['\\neg', 'not 非'], ['\\top', 'top 真'], ['\\bot', 'bottom 假'],
      ['\\angle', 'angle 角'], ['\\triangle', 'triangle 三角'], ['\\square', 'square 方块', 'amssymb'], ['\\Box', 'box', 'amssymb'],
      ['\\ell', 'ell'], ['\\hbar', 'hbar 普朗克'], ['\\Re', 'real part 实部'], ['\\Im', 'imaginary part 虚部'], ['\\aleph', 'aleph'],
      ['\\wp', 'weierstrass'], ['\\prime', 'prime 撇'], ['\\ldots', 'dots 省略号'], ['\\cdots', 'center dots'], ['\\vdots', 'vertical dots'],
      ['\\ddots', 'diagonal dots'], ['\\therefore', 'therefore 所以', 'amssymb'], ['\\because', 'because 因为', 'amssymb'],
      ['\\degree', 'degree 度', 'gensymb'], ['^{\\circ}', 'degree 度'], ['\\dagger', 'dagger'], ['\\ddagger', 'double dagger'],
      ['\\S', 'section 节'], ['\\P', 'paragraph 段'], ['\\copyright', 'copyright'], ['\\checkmark', 'check 对勾', 'amssymb'],
    ],
  },
];
