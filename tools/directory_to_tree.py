import os
import argparse
import logging
from pathlib import Path

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)

DEFAULT_IGNORE_DIRS = {'node_modules', '__pycache__', '.git', '.vscode', '.idea'}

def is_ignored(path, ignore_dirs):
    """Check if the path is inside any ignored directory."""
    for part in path.parts:
        if part in ignore_dirs:
            return True
    return False

def build_tree(directory_path, ignore_dirs, show_files=True, max_depth=None):
    """
    Build a list of tree lines for the given directory.

    Args:
        directory_path (Path): Directory to traverse.
        ignore_dirs (set[str]): Directory names to ignore.
        show_files (bool): Whether to include files in the tree.
        max_depth (int | None): Maximum depth to descend (None = unlimited).

    Returns:
        list[str]: Tree lines, e.g. ['src/', '  core/', '    Engine.ts'].
    """
    lines = []

    def walk(current, depth, prefix):
        if max_depth is not None and depth > max_depth:
            return
        entries = sorted(current.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
        entries = [e for e in entries if not is_ignored(e, ignore_dirs)]
        for i, entry in enumerate(entries):
            last = (i == len(entries) - 1)
            connector = '└── ' if last else '├── '
            lines.append(f"{prefix}{connector}{entry.name}")
            if entry.is_dir():
                extension = '    ' if last else '│   '
                walk(entry, depth + 1, prefix + extension)

    walk(directory_path, 0, '')
    return lines

def directory_to_tree(
        directory_path, output_file,
        ignore_dirs=None, show_files=True, max_depth=None):
    """
    Generate a markdown file tree of the given directory.

    Args:
        directory_path (str | Path): Directory to traverse.
        output_file (str | Path): Markdown file to generate.
        ignore_dirs (set[str]): Directory names to ignore.
        show_files (bool): Whether to include files in the tree.
        max_depth (int | None): Maximum depth to descend.
    """
    directory_path = Path(directory_path).resolve()
    output_file = Path(output_file).resolve()

    if ignore_dirs is None:
        ignore_dirs = DEFAULT_IGNORE_DIRS

    logging.info(f"Scanning directory: {directory_path}")
    tree_lines = build_tree(directory_path, ignore_dirs, show_files, max_depth)

    with output_file.open('w', encoding='utf-8') as md:
        md.write("# 文件树\n\n")
        md.write(f"```\n{directory_path.name}/\n")
        for line in tree_lines:
            md.write(f"{line}\n")
        md.write("```\n")

    logging.info(f"Tree written to '{output_file}' with {len(tree_lines)} entries.")

if __name__ == '__main__':
    parser = argparse.ArgumentParser(
        description="Generate a markdown file tree of a directory."
    )
    parser.add_argument("directory", help="Path to the directory to scan.")
    parser.add_argument(
        "-o", "--output", default="file_tree.md",
        help="Output markdown file (default: file_tree.md)"
    )
    parser.add_argument(
        "--ignore", nargs='*', default=list(DEFAULT_IGNORE_DIRS),
        help="Directories to ignore (default: node_modules __pycache__ .git .vscode .idea)"
    )
    parser.add_argument(
        "--no-files", action='store_true',
        help="Show directories only, omit files."
    )
    parser.add_argument(
        "-d", "--depth", type=int, default=None,
        help="Maximum depth to descend (default: unlimited)"
    )

    args = parser.parse_args()

    directory_to_tree(
        args.directory, args.output,
        ignore_dirs=set(args.ignore),
        show_files=not args.no_files,
        max_depth=args.depth
    )
