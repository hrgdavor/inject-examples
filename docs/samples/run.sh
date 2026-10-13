#!/bin/sh
# #region config
# A shell script has no members to name, so a region is how its settings stay
# addressable — and the directive lines are never injected.
CATALOG="bolt nut washer"
HOST="localhost"
# #endregion

# The heredoc body is data: the brace in it is not shell syntax.
deploy() {
	cat <<EOF
  } decoy
EOF
	echo "deployed"
}

# A `case` arm is an arm and not a block, so a region directive names this one.
# #region count
count() {
	echo "$CATALOG" | wc -w
}
# #endregion

legacy() { # count
	echo "$CATALOG" | wc -w
}
