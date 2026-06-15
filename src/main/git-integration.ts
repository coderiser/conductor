import simpleGit from 'simple-git';

export async function getGitStatus(repoPath: string): Promise<{ branch: string | null; dirty: boolean; repoExists: boolean }> {
  try {
    const git = simpleGit(repoPath);
    const isRepo = await git.checkIsRepo();

    if (!isRepo) {
      return { branch: null, dirty: false, repoExists: false };
    }

    const status = await git.status();
    const branch = status.current || null;
    const dirty = !status.isClean();

    return { branch, dirty, repoExists: true };
  } catch {
    return { branch: null, dirty: false, repoExists: false };
  }
}
