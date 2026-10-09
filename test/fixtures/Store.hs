module Store where

add :: Int -> Int -> Int
add x y = x + y

data Cart = Cart { items :: [Int] }
