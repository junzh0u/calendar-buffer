#!/usr/bin/env zsh
setopt err_exit pipe_fail

script_dir="${0:A:h}"
cd "$script_dir"

# Pick a clasp runner: PATH install, else ad hoc via bunx/npx
if (( $+commands[clasp] )); then
    clasp=(clasp)
elif (( $+commands[bunx] )); then
    clasp=(bunx @google/clasp)
elif (( $+commands[npx] )); then
    clasp=(npx -y @google/clasp)
else
    echo "Need clasp, bunx, or npx on PATH" >&2
    exit 1
fi

# ~/.clasprc.json holds clasp's credentials; log in if it's missing
if [[ ! -f ~/.clasprc.json ]]; then
    echo "Logging in to clasp (opens a browser)"
    $clasp login
fi

# First deploy: create the Apps Script project (writes .clasp.json, gitignored)
if [[ -f .clasp.json ]]; then
    first_deploy=false
else
    echo "Creating Apps Script project"
    $clasp create --type standalone --title calendar-buffer
    # clasp create overwrites the local manifest with the remote default — restore ours
    git checkout -- appsscript.json
    first_deploy=true
fi

# -f: overwrite the remote manifest without prompting
$clasp push -f

if $first_deploy; then
    cat <<EOF
Pushed. Finish setup in the Apps Script editor (opening now):
  1. Run the install() function once (grants auth, creates the triggers)
  2. Tag a calendar event with the Graphite color to test
EOF
    $clasp open-script
else
    echo "Done. Code updated; triggers unchanged."
fi
