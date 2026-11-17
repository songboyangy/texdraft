import type { ProjectSummary } from '@texdraft/shared';
import { encodeInitialState } from '../collab/hocuspocus.js';
import { db, schema } from '../db/client.js';

/**
 * 示例项目：中文短文 + 公式 + 参考文献，让新用户一进来就有东西可以试（改写段落、编译、加引用）。
 * SAMPLE_PROJECT（PUBLIC_DEMO 时默认开启）：每位新注册用户自动获得一份自己的副本。
 * 参考文献都是真实存在的出版物。
 */
export const SAMPLE_NAME = 'TeXdraft 示例：注意力机制简介';

const MAIN = String.raw`\documentclass[11pt]{article}
\usepackage[UTF8]{ctex}
\usepackage[margin=2.5cm]{geometry}
\usepackage{amsmath,amssymb}
\usepackage{booktabs}
\usepackage{hyperref}

\title{注意力机制简介}
\author{TeXdraft 示例}
\date{}

\begin{document}
\maketitle

\begin{abstract}
本文用一页篇幅介绍 Transformer 中的缩放点积注意力，演示 TeXdraft 的编辑、编译与 AI 修改功能。
\end{abstract}

% 第一次打开时会有新手引导，带你认识编辑、编译、AI 修改等功能；
% 之后想再看一遍，点右上角「⋯ → 新手引导」。

\section{引言}

注意力机制是现在深度学习里面非常非常重要的一个东西，它的作用大概就是让模型在处理一个序列的时候，可以去看序列里面别的位置的信息，然后根据相关程度来决定看多少，这样的话模型就能够比较好地处理长距离的依赖关系，所以后来很多模型都用了它。

Transformer 模型完全基于注意力机制，抛弃了循环与卷积结构\cite{vaswani2017attention}。它在机器翻译等任务上取得了显著效果，并成为后续大规模语言模型的基础架构。

\section{缩放点积注意力}

给定查询矩阵 $Q$、键矩阵 $K$ 与值矩阵 $V$，缩放点积注意力定义为
\begin{equation}
  \operatorname{Attention}(Q, K, V) = \operatorname{softmax}\!\left(\frac{QK^{\top}}{\sqrt{d_k}}\right) V,
  \label{eq:attention}
\end{equation}
其中 $d_k$ 为键向量的维度。除以 $\sqrt{d_k}$ 是为了避免点积数值过大、导致 softmax 进入梯度很小的区域。

多头注意力把式~\eqref{eq:attention} 并行计算 $h$ 次，再拼接各头的输出：
\begin{equation}
  \operatorname{MultiHead}(Q, K, V) = \operatorname{Concat}(\mathrm{head}_1, \dots, \mathrm{head}_h)\, W^{O}.
\end{equation}

\section{常见配置}

表~\ref{tab:config} 列出了原论文中基础模型的主要超参数。

\begin{table}[h]
  \centering
  \begin{tabular}{lc}
    \toprule
    超参数 & 取值 \\
    \midrule
    层数 $N$ & 6 \\
    模型维度 $d_{\text{model}}$ & 512 \\
    注意力头数 $h$ & 8 \\
    前馈层维度 $d_{\text{ff}}$ & 2048 \\
    \bottomrule
  \end{tabular}
  \caption{Transformer 基础模型的超参数}
  \label{tab:config}
\end{table}

\section{结语}

本文的排版使用 \LaTeX{} 完成，其底层的 \TeX{} 排版系统由 Knuth 设计\cite{knuth1984texbook}。

\bibliographystyle{plain}
\bibliography{refs}

\end{document}
`;

const REFS = String.raw`@inproceedings{vaswani2017attention,
  title     = {Attention Is All You Need},
  author    = {Vaswani, Ashish and Shazeer, Noam and Parmar, Niki and Uszkoreit, Jakob and Jones, Llion and Gomez, Aidan N. and Kaiser, {\L}ukasz and Polosukhin, Illia},
  booktitle = {Advances in Neural Information Processing Systems},
  volume    = {30},
  year      = {2017}
}

@book{knuth1984texbook,
  title     = {The {\TeX}book},
  author    = {Knuth, Donald E.},
  publisher = {Addison-Wesley},
  year      = {1984}
}
`;

export const SAMPLE_FILES = [
  { path: 'main.tex', content: MAIN },
  { path: 'refs.bib', content: REFS },
];

/** 为用户创建一份示例项目（不受项目数配额限制：注册时自动创建） */
export async function createSampleProject(userId: string): Promise<ProjectSummary> {
  const files = SAMPLE_FILES;
  const project = await db.transaction(async (tx) => {
    const [p] = await tx.insert(schema.projects).values({ ownerId: userId, name: SAMPLE_NAME, mainFile: 'main.tex', engine: 'xelatex' }).returning();
    await tx.insert(schema.projectMembers).values({ projectId: p.id, userId, role: 'owner' });
    for (const f of files) {
      const [row] = await tx
        .insert(schema.files)
        .values({ projectId: p.id, path: f.path, kind: 'text', size: Buffer.byteLength(f.content) })
        .returning();
      await tx.insert(schema.docStates).values({ fileId: row.id, state: encodeInitialState(f.content) });
    }
    return p;
  });
  return { id: project.id, name: project.name, role: 'owner', updatedAt: project.updatedAt.toISOString() };
}
