Agents are **not** allowed to create or modify any file under [`design/`](./design/) under **any** circumstances, even when explicitly asked by the user.

The file [`design/requirements/README.md`](./design/requirements/README.md) contains an index of hand-written user requirements separated by topic.
Agents should consult the index and look up relevant requirements when making changes or suggesting changes to code. 
Agents are **not** supposed to modify any file under [`design/requirements/`](./design/requirements/) under any circumstances, even when explicitly asked by the user.
Agents are allowed to teach the user how the requirements should be updated, but the update should be left to the user.

Agents should ensure text files it creates use linux line-ending regardless of the current platform.
