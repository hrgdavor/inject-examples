#!/bin/sh
# The heredoc body is data: the brace in it is not shell syntax.
deploy() {
	cat <<EOF
  } decoy
EOF
	echo "deployed"
}
