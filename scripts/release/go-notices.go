package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
)

type module struct {
	Path, Version, Dir string
	Main               bool
	Replace            *module
}

func notice(name, source, directory string) {
	entries, err := os.ReadDir(directory)
	if err != nil {
		panic(err)
	}
	found := false
	for _, entry := range entries {
		upper := strings.ToUpper(entry.Name())
		if entry.IsDir() || !(strings.HasPrefix(upper, "LICENSE") || strings.HasPrefix(upper, "NOTICE") || strings.HasPrefix(upper, "COPYING")) {
			continue
		}
		if upper == "LICENSE-LOGO" {
			continue
		}
		data, err := os.ReadFile(filepath.Join(directory, entry.Name()))
		if err != nil || len(data) == 0 {
			panic("missing dependency license: " + name)
		}
		fmt.Printf("\n%s\nSource: %s\n%s SHA-256: %x\n\n%s\n", name, source, entry.Name(), sha256.Sum256(data), strings.TrimRight(string(data), "\n"))
		found = true
	}
	if !found {
		panic("missing dependency license: " + name)
	}
}

func main() {
	command := exec.Command("go", "list", "-mod=readonly", "-deps", "-json", "./cmd/jotter")
	command.Stderr = os.Stderr
	data, err := command.Output()
	if err != nil {
		panic(err)
	}
	modules := map[string]module{}
	decoder := json.NewDecoder(bytes.NewReader(data))
	for {
		var pkg struct{ Module *module }
		if err := decoder.Decode(&pkg); err == io.EOF {
			break
		} else if err != nil {
			panic(err)
		}
		if pkg.Module != nil && !pkg.Module.Main {
			if pkg.Module.Replace != nil || pkg.Module.Version == "" {
				panic("unversioned/replaced release dependency")
			}
			modules[pkg.Module.Path] = *pkg.Module
		}
	}
	fmt.Println("Jotter Go dependency notices")
	notice("Go "+runtime.Version(), "https://go.dev/dl/", runtime.GOROOT())
	names := make([]string, 0, len(modules))
	for name := range modules {
		names = append(names, name)
	}
	slices.Sort(names)
	for _, name := range names {
		m := modules[name]
		notice(name+"@"+m.Version, "https://pkg.go.dev/"+name+"@"+m.Version, m.Dir)
	}
}
