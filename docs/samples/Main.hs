-- | A tiny store: a binding, the signature that labels it, and a record.
module Main where

add :: Int -> Int -> Int
add x y = x + y

data Cart = Cart { items :: [Int] }
