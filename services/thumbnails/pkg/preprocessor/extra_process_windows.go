package preprocessor

import "os/exec"

func configureExtraProcess(cmd *exec.Cmd) {}

func stopExtraProcess(cmd *exec.Cmd) {
	if cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
}
